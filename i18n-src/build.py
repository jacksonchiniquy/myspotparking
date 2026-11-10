# Builds netlify/functions/lib/i18n/<code>.json from every phase*.py in this folder.
# Checks each translation keeps the same {fill-ins} as the English.
import glob, importlib.util, json, re, os, sys
CODES = ['es', 'zh', 'vi', 'tl', 'pt', 'fr', 'ko']
here = os.path.dirname(os.path.abspath(__file__))
allT, bad = {}, []
for f in sorted(glob.glob(os.path.join(here, 'phase*.py'))):
    spec = importlib.util.spec_from_file_location('m', f); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    for k, v in m.T.items():
        if len(v) != len(CODES): bad.append(f'{k!r}: has {len(v)} translations')
        want = sorted(re.findall(r'\{\w+\}', k))
        for c, s in zip(CODES, v):
            if sorted(re.findall(r'\{\w+\}', s)) != want: bad.append(f'{c} {k!r}: fill-ins differ')
            if '[' in k and ('[' not in s or ']' not in s): bad.append(f'{c} {k!r}: link brackets missing')
        allT[k] = v
if bad: print('\n'.join(bad)); sys.exit(1)
out = os.path.join(here, '..', 'netlify', 'functions', 'lib', 'i18n')
os.makedirs(out, exist_ok=True)
for i, c in enumerate(CODES):
    with open(os.path.join(out, c + '.json'), 'w', encoding='utf-8') as fh:
        json.dump({k: v[i] for k, v in allT.items()}, fh, ensure_ascii=False, indent=0, sort_keys=True)
print(f'{len(allT)} phrases × {len(CODES)} languages written')
