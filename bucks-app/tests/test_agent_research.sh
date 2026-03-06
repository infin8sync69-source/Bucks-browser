#!/bin/bash
# Test Agent Research & Synthesis Capability

API_URL="http://localhost:3000/api/v1/swarm/task"

echo "🧪 Testing Research Synthesis Pipeline..."

# 1. Simulate a deep research prompt
PROMPT="Research the latest updates on Ethereum L2s from 3 different sources and provide a consolidated summary."

echo "--- Sending Research Prompt ---"
RESPONSE=$(curl -s -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d "{
    \"prompt\": \"$PROMPT\",
    \"current_url\": \"bucks://newtab\",
    \"current_title\": \"Bucks\"
  }")

echo "Response received:"
echo $RESPONSE | jq .

# 2. Extract Task ID and evaluation
TASK_ID=$(echo $RESPONSE | jq -r .task_id)
EVAL=$(echo $RESPONSE | jq -r .evaluation)

if [[ "$EVAL" == *"synthesis"* ]] || [[ "$EVAL" == *"scrape"* ]] || [[ "$EVAL" == *"navigate"* ]]; then
  echo "✅ SUCCESS: Architect generated research/synthesis actions."
else
  echo "❌ FAILURE: Architect did not initiate research loop."
fi

echo "--- End of Test ---"
