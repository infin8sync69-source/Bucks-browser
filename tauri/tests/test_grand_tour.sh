#!/bin/bash

# Solar Parsec Grand Tour - Capability Verification Suite
# This script simulates complex user workflows to verify the agent's orchestration capabilities.

API_URL="http://localhost:3000/api/v1/swarm/task"
FEEDBACK_URL="http://localhost:3000/api/v1/swarm/feedback"

echo "=== Starting Solar Parsec Grand Tour ==="

# Test Case 1: Comparative Research
echo "[Test 1] Objective: Comparative Research across multiple sources"
curl -X POST $API_URL \
     -H "Content-Type: application/json" \
     -d '{
       "prompt": "Compare the consensus mechanisms of Bitcoin, Ethereum, and Bucks. Provide a technical summary.",
       "current_url": "bucks://home",
       "current_title": "Lumina Home"
     }'
echo -e "\n"

# Test Case 2: Multi-Step Interaction (Simulated)
echo "[Test 2] Objective: Complex Interaction (Auth + Navigation)"
curl -X POST $API_URL \
     -H "Content-Type: application/json" \
     -d '{
       "prompt": "Go to the developer docs, find the A2UI section, and show me the JSON schema for the 'click' action.",
       "current_url": "https://docs.solarparsec.io",
       "current_title": "Developer Docs"
     }'
echo -e "\n"

# Test Case 3: Blockchain Action
echo "[Test 3] Objective: Internal Browser Action (Wallet)"
curl -X POST $API_URL \
     -H "Content-Type: application/json" \
     -d '{
       "prompt": "Open my Bucks wallet and check my pending transactions.",
       "current_url": "bucks://home",
       "current_title": "Lumina Home"
     }'
echo -e "\n"

# Test Case 4: Feedback Loop (Simulated)
echo "[Test 4] Objective: Verify Feedback API Endpoint"
curl -X POST $FEEDBACK_URL \
     -H "Content-Type: application/json" \
     -d '{
       "task_id": "test-task-123",
       "score": 1,
       "correction": "The consensus mechanism is actually Proof-of-Trust, not Proof-of-Stake."
     }'
echo -e "\n"

echo "=== Grand Tour Simulation Complete ==="
