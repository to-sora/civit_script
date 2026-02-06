basedir="$HOME/ComfyUI"

# Global flag for bypass confirmation
BYPASS_CONFIRM=false

# Check for -Y argument to bypass user confirmation
for arg in "$@"; do
    if [[ "$arg" == "-Y" ]]; then
        BYPASS_CONFIRM=true
    fi
done

linker() {
    local LINK_PATH="$1"
    local TARGET_PATH="$2"
    
    # 1. CASE: IT IS A REAL DIRECTORY (Not a symlink)
    if [ -d "$LINK_PATH" ] && [ ! -L "$LINK_PATH" ]; then
        echo "---------------------------------------------------"
        echo "DETECTED DIRECTORY at: $LINK_PATH"
        echo "Target is: $TARGET_PATH"
        
        if [ "$BYPASS_CONFIRM" = false ]; then
            echo "We need to merge this directory into the target before linking."
            read -p "Are you sure you want to merge and delete '$LINK_PATH'? [y/N] " -n 1 -r
            echo    # move to a new line
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Skipping..."
                return 1
            fi
        else
            echo "Auto-confirming merge (-Y passed)."
        fi

        # Generate timestamp for backup suffix
        local timestamp
        timestamp=$(date +"_%Y%m%d_%H%M%S")

        echo "DEBUG: Merging with rsync (backing up duplicates with suffix $timestamp)..."
        
        # CHANGED: Replaced -av with -rltv to avoid permission/ownership errors on shared drives
        # -r: recursive
        # -l: copy symlinks
        # -t: preserve modification times
        # -v: verbose
        # We OMIT -p, -o, -g so files inherit permissions/group from the destination folder
        rsync -rltv --remove-source-files --backup --suffix="$timestamp" "$LINK_PATH/" "$TARGET_PATH/"

        if [ $? -eq 0 ]; then
            echo "DEBUG: Rsync merge successful."
            # Remove the now empty directory structure
            rm -rf "$LINK_PATH"
            echo "DEBUG: Directory removed. Ready to link."
        else
            echo "ERROR: Rsync failed with code $?. Aborting link creation."
            return 1
        fi
    fi
    
    # 2. CASE: IT IS A SYMLINK (Existing)
    if [ -L "$LINK_PATH" ]; then
        local current_target
        current_target=$(readlink -f "$LINK_PATH")
        
        # Optional: Check if symlink points to the correct location
        # Since standard readlink might return relative paths or canonical paths differently, 
        # strictly checking string equality can sometimes be tricky, but this is usually sufficient.
        if [ "$current_target" != "$TARGET_PATH" ]; then
             # If you want to force update existing links, uncomment below:
             # echo "DEBUG: Updating symlink: $LINK_PATH"
             # rm "$LINK_PATH"
             # ln -s "$TARGET_PATH" "$LINK_PATH"
             echo "DEBUG: Symlink exists: $LINK_PATH -> $current_target"
        fi
        return 0
    fi
    
    # 3. CASE: IT IS A FILE (Error)
    if [ -e "$LINK_PATH" ]; then
        echo "WARNING: Existing regular file found at $LINK_PATH. Cannot link. EXIT"
        return 1
    fi
    
    # 4. CASE: DOES NOT EXIST (Create new link)
    echo "DEBUG: Creating new symlink: $LINK_PATH -> $TARGET_PATH"
    mkdir -p "$(dirname "$LINK_PATH")"
    ln -s "$TARGET_PATH" "$LINK_PATH"
    return 0
}

# --- Main Execution ---

if [ ! -d "$basedir" ]; then
    echo "Error: Base directory $basedir does not exist."
    exit 1
fi

cd "$basedir" || exit

# Source venv if it exists
if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
fi

# Run Linkers
linker "$basedir/input" "/mnt/4T/Comfyui_MAIN/input"
linker "$basedir/output" "/mnt/4T/Comfyui_MAIN/output"
linker "$HOME/ComfyUI/user/default/workflows"  "/mnt/4T/Comfyui_MAIN/workflows"
# Clean up old model symlinks
# Note: Added -maxdepth 1 to avoid accidentally deleting things deep inside subfolders if models/ is a real dir
if [ -d "$basedir/models" ]; then
    find "$basedir/models" -maxdepth 1 -type l -exec sh -c 'rm "$1"' sh {} \;
fi

# Run the Civit Link Builder
if [ -f "$basedir/civit_script/Comfyui_link_builder.sh" ]; then
    bash "$basedir/civit_script/Comfyui_link_builder.sh" models/ /mnt/4T/Comfyui_P2/models/ /mnt/4T/Comfyui_P1/models/ /mnt/4T/Comfyui_MAIN/models/ /mnt/4T/SD_MODEL_output/models
else
    echo "WARNING: Link builder script not found at $basedir/civit_script/Comfyui_link_builder.sh"
fi

# Start ComfyUI
python main.py --enable-manager --listen 0.0.0.0
