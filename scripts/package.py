from pathlib import Path
import json
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
extension = root / 'extension'
manifest = json.loads((extension / 'manifest.json').read_text())
folder = f"photos-album-archiver-v{manifest['version']}"
output = root / 'dist' / f'{folder}.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(extension.iterdir()):
        if path.is_file():
            archive.write(path, f'{folder}/{path.name}')
    archive.write(root / 'README.md', f'{folder}/README.md')
with ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit('The generated ZIP failed its integrity check.')
print(output)
