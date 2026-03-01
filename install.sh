python -m venv venv
source venv/bin/activate
pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130 && pip install -r requirements.txt && pip install -r manager_requirements.txt
