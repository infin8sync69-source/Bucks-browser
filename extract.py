import re
import os

with open('/Users/mikado/Downloads/Liquid Glass Browser Landing Page/Bucks Landing.dc.html', 'r') as f:
    content = f.read()

# Extract everything inside <x-dc>...</x-dc>
match = re.search(r'<x-dc>(.*?)</x-dc>', content, re.DOTALL)
if not match:
    print("No x-dc found")
    exit(1)

html = match.group(1)

# Remove <sc-helmet> and </sc-helmet> (but keep contents)
html = re.sub(r'<helmet[^>]*>', '', html)
html = re.sub(r'</helmet>', '', html)

# Replace <sc-if> and </sc-if>
html = re.sub(r'<sc-if[^>]*>', '', html)
html = re.sub(r'</sc-if>', '', html)

# Replace <sc-for> and </sc-for>
html = re.sub(r'<sc-for[^>]*>', '', html)
html = re.sub(r'</sc-for>', '', html)

# Clean up {{ }} bindings
html = re.sub(r'\{\{[^\}]+\}\}', '', html)
html = re.sub(r'onClick="[^\"]*"', '', html)
html = re.sub(r'onChange="[^\"]*"', '', html)
html = re.sub(r'onKeyDown="[^\"]*"', '', html)
html = re.sub(r'onDragStart="[^\"]*"', '', html)
html = re.sub(r'onDragOver="[^\"]*"', '', html)
html = re.sub(r'onDrop="[^\"]*"', '', html)
html = re.sub(r'onDragEnd="[^\"]*"', '', html)
html = re.sub(r'style="\"', '', html)
html = re.sub(r'style-hover="[^"]*"', '', html)

with open('/Users/mikado/Desktop/Bucks Core/Bucks-browser/extracted.html', 'w') as f:
    f.write(html)
print("Extracted HTML successfully")
