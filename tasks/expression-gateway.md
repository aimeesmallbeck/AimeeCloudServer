# Task: Update Gateway to Support Expression Commands

## Context
The gateway needs to be updated to support sending expression commands to robots as part of the response command array.

## What to Update

Update `/home/scott/aimeecloud-deploy/aimeecloud-mqtt-gateway.js` to:

1. Add a function `buildExpressionCommand(name, options)` that builds expression command objects
2. Add auto-expression injection based on context (similar to the rules in PHYSICAL_EXPRESSIVENESS_SPEC.md):
   - On LLM stream start: inject "thinking" expression
   - On game win: inject "happy" expression  
   - On negative sentiment: inject "sad" expression
   - On connection: inject "greeting" expression

3. Update the response building to include expression commands in the commands array

## Keep Existing Behavior
- Don't break existing motor/arm commands
- Don't change the response format significantly
- Just add expression commands alongside existing commands

## Output
Gateway updated to support expression commands in responses.