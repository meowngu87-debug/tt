# Maya World/User Agent Runtime

Runtime layer for the Maya WORLD/USER architecture. The runtime is designed to make a persistent text-world operate smoothly without turning the USER layer into a second GM.

## Core architecture

```
WORLD_STATE
   |
   | perception / reveal boundary
   v
PERCEPTION_STATE
   |
   +---- Persona
   +---- Actual User Input
   |
   v
USER_PROCESSOR
   |
   v
USER_RESULT
   |
   v
WORLD_ENGINE
   |
   +---- hidden WORLD_STATE
   +---- background ledger
   +---- NPC state / knowledge
   +---- time / events / consequences
   |
   v
new PERCEPTION_STATE
   |
   v
MAIN NARRATIVE
```

The important firewall is:

```
WORLD INTERNAL STATE  X->  USER PROCESSOR
WORLD STATE            ->  PERCEPTION_STATE -> USER PROCESSOR
```

The User must not be isolated from the world. The User must only receive the part of the world that the User can actually experience or validly know.

## USER layer

The USER processor receives exactly these sources:

- active User Persona;
- the current real User input;
- the current User Perceived World.

The User Perceived World can contain:

- current perceived time and location;
- visible context;
- visible entities and their observable state;
- sensory information;
- immediate consequences already experienced;
- facts the User has legitimately learned;
- recent valid reveals.

The USER processor uses that information to resolve references and interpret the input. It must not invent:

- new User decisions;
- new User dialogue;
- hidden motives, memories or emotions;
- NPC reactions;
- world events;
- outcomes or consequences.

When information is genuinely ambiguous, the processor preserves the ambiguity instead of inventing an answer.

## WORLD layer

The WORLD engine owns:

- world time and world state;
- NPC state, knowledge, awareness and interest;
- relationships;
- events and consequences;
- background/off-screen activity;
- LOCAL/GLOBAL simulation scope;
- the reveal boundary;
- construction of the next User Perceived World.

NPC knowledge remains local to each NPC. GLOBAL simulation does not mean the User or every NPC knows everything.

Important NPCs are persisted in state. Lightweight NPCs can be represented by role, current state, knowledge and context; they do not require one separate AI each.

## Perception boundary

`PERCEPTION_STATE` is separate from hidden `WORLD_STATE`.

Information enters the User side only through:

- direct witnessing;
- hearing;
- report;
- rumor;
- trace/evidence;
- consequence;
- justified inference.

The hidden background ledger is never directly injected into the main narrative.

A background event may be stored as:

```
SIMULATED -> HIDDEN -> REVEALED -> RESOLVED
```

Main narrative remains a User perception window instead of omniscient narration.

## Existing preset authority

This extension does not replace the existing Maya preset systems.

The preset remains authoritative for:

- D100;
- Action Roll;
- World Roll;
- dice veto and outcome interpretation;
- Character Autonomy;
- OCC protection;
- prose/style/world rules.

The auxiliary WORLD call prepares state and context. It is explicitly told not to secretly replace the preset's final D100 result.

## Persistence

State is stored per chat in `chatMetadata` under:

`maya_world_user_agent_state`

State includes:

- `world`
- `npcs`
- `relationships`
- `knowledge`
- `events`
- `background_ledger`
- `reveals`
- `perception`
- `runtime`

Long-running chats are bounded by configurable limits so metadata does not grow without limit.

v0.3 also migrates the older v0.1/v0.2 state shape and preserves the old background ledger and array-style NPC/relationship updates when possible.

## Continuity behavior

The runtime:

- prevents duplicate processing of the same user message;
- advances ongoing off-screen activity between User turns;
- keeps hidden background activity in state rather than prose;
- preserves continuity when nothing meaningful changes;
- keeps User knowledge separate from NPC/private knowledge;
- provides a structured perception window for pronouns, locations, visible NPCs and immediate consequences;
- seeds the new perception layer from the last already-visible assistant message when a chat is upgraded from an older state.

The runtime does not currently tick the world while the chat is completely idle. World simulation advances when the User generation pipeline runs.

## Installation

Install the extension through SillyTavern's third-party extension mechanism or place the folder under the ST third-party extensions directory, then reload ST.

Enable:

`Maya World/User Agent Runtime -> Enable runtime`

Keep:

`Run automatically before normal generation`

enabled for normal use.

## Current limitation

The auxiliary User and World calls use the currently selected SillyTavern connection/profile. The separation is a context/information firewall, not a separate-model architecture.

The extension does not edit presets, MVU, Regex, scripts or other ST configuration. Those remain outside this runtime layer.
