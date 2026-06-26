import re

with open('electron/renderer.js', 'r') as f:
    content = f.read()

# Replace $('#btn...').addEventListener(...) with document.querySelector('#btn...')?.addEventListener(...)
# Actually a simpler regex that replaces $(...).addEventListener with $(...)?.addEventListener
content = re.sub(r"(\$\('[^']+'\))\.addEventListener", r"\1?.addEventListener", content)

# For .onclick, we can replace $('#btn...').onclick = ... with const btn = $('#btn...'); if(btn) btn.onclick = ...
# But easier is just replacing the $() function to return an empty object with noops if not found for specific cases, or just use regex:
content = re.sub(r"(\$\('[^']+'\))\.onclick\s*=", r"\1 && (\1.onclick =", content)
# Wait, `$('#btn').onclick = function() {}` -> `$('#btn') && ($('#btn').onclick = function() {})`
# This is valid JS syntax.

with open('electron/renderer.js', 'w') as f:
    f.write(content)
