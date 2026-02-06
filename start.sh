basedir="$HOME/ComfyUI"
linker() {
    local LINK_PATH="$1"
    local TARGET_PATH="$2"
    
    if [ -d "$LINK_PATH" ] && [ ! -L "$LINK_PATH" ]; then
        echo "WARNING: $LINK_PATH is a directory. Exit."
        return 1
    fi
    
    if [ -L "$LINK_PATH" ]; then
        echo "DEBUG: Removing existing symlink: $LINK_PATH"
        rm "$LINK_PATH"
        echo "DEBUG: Creating symlink: $LINK_PATH -> $TARGET_PATH"
        ln -s "$TARGET_PATH" "$LINK_PATH"
        return 0
    fi
    
    if [ -e "$LINK_PATH" ]; then
        echo "WARNG:  Existing file: $LINK_PATH EXIT"
        return 1
    fi
    
    echo "DEBUG: Creating new symlink: $LINK_PATH -> $TARGET_PATH"
    ln -s "$TARGET_PATH" "$LINK_PATH"
    return 0
}

cd $basedir
source venv/bin/activate
linker "$basedir/input" "/mnt/4T/Comfyui_MAIN/input"
linker "$basedir/output" "/mnt/4T/Comfyui_MAIN/output"
find "$basedir/models" -type l -exec sh -c 'rm "$1"' sh {} \;
bash "$basedir/civit_script/Comfyui_link_builder.sh" models/ /mnt/4T/Comfyui_P2/models/ /mnt/4T/Comfyui_P1/models/ /mnt/4T/Comfyui_MAIN/models/ /mnt/4T/SD_MODEL_output/models
python main.py --enable-manager --listen 0.0.0.0
