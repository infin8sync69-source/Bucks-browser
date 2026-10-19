import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace complex linear gradients with monolithic surface backgrounds
content = re.sub(r'background:\s*linear-gradient\([^;]+\);?', 'background: var(--bucks-bg-surface);', content)

# Replace complex radial gradients with monolithic surface backgrounds
content = re.sub(r'background:\s*radial-gradient\([^;]+\)[^;]*;?', 'background: var(--bucks-bg-surface);', content)

# Replace specific colored backgrounds with monolithic tokens
content = re.sub(r'background:\s*#[a-fA-F0-9]{3,6};?', 'background: var(--bucks-bg-surface);', content)

# Replace complex box shadows
content = re.sub(r'box-shadow:\s*[^;]+rgba\([^;]+\)[^;]*;?', 'box-shadow: var(--bucks-shadow-md);', content)

# Remove emojis
import emoji
content = emoji.replace_emoji(content, replace='')

# Specific emoji removal if the library misses some
content = re.sub(r'[✈️💻📄🕒☀️🗓🎵⚡📝📈📁]', '', content)
content = re.sub(r'[\u2600-\u26FF\u2700-\u27BF\u1F300-\u1F5FF\u1F600-\u1F64F\u1F680-\u1F6FF\u1F900-\u1F9FF\u1FA70-\u1FAFF]', '', content)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)
