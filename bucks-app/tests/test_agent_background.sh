#!/bin/bash

# Agent Background Browsing Verification
# This script ensures the architect and frontend can handle background agent activities.

API_URL="http://localhost:3000/api/v1/swarm/task"

echo "=== Starting Agent Background Browsing Test ==="

# Test Case: Multi-Tab Research Simulation
# The agent is expected to navigate to multiple sources to gather info.
echo "[Test 1] Objective: Research Decentralized Swarms (Multi-Tab)"
curl -X POST $API_URL \
     -H "Content-Type: application/json" \
     -d '{
       "prompt": "Research decentralized swarm intelligence across multiple sources and summarize the key findings.",
       "current_url": "bucks://home",
       "current_title": "Bucks Home"
     }'

echo -e "\n"
echo "[Info] Verification: Open the Bucks app. Trigger this prompt in the Agentic Bar."
echo "[Info] EXPECTED: The agent should open background tabs for research while you stay on the home page."
echo "[Info] CHECK: Look at the console logs or use the Tab overview to see background agent tabs."

# Test Case: Background Navigation
echo "[Test 2] Objective: Background Navigation"
curl -X POST $API_URL \
     -H "Content-Type: application/json" \
     -d '{
       "prompt": "Navigate to github.com in the background and check for Bucks-browser updates.",
       "current_url": "https://google.com",
       "current_title": "Google"
     }'

echo -e "\n"
echo "=== Agent Background Browsing Test Complete ==="
