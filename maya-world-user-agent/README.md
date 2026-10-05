# Maya World/User Agent Runtime

Runtime layer for the Maya WORLD/USER architecture. The goal is not to become a general ST automation agent; the goal is to make persistent text-world simulation smoother and safer.

## Core flow

USER INPUT -> USER PROCESSOR -> USER_RESULT -> WORLD ENGINE -> persistent WORLD STATE -> reveal boundary -> MAIN NARRATIVE

### USER layer

The User processor receives only the current real user input and the active user persona. It extracts what the user actually did, said, or clearly intended.

It must not invent new user decisions, dialogue, memories, motives, hidden emotions, actions not taken by the user, or NPC reactions.

### WORLD layer

The World engine owns time and location, NPC state, NPC knowledge, NPC awareness and interest, relationships, active events, background events, consequences, LOCAL/GLOBAL simulation scope, and reveal channels.

NPCs do not need a separate AI each. Important NPC state is persisted; lightweight NPCs can be represented by role, current state, knowledge and context.

## Persistent state

State is stored per chat in chatMetadata:

- world
- npcs
- relationships
- knowledge
- events
- background_ledger
- reveals
- runtime turn fingerprint

The background ledger is hidden state. It is not directly injected into the main narrative.

## Reveal boundary

Hidden information can reach the user only through a valid channel:

- witnessed
- heard
- reported
- rumor
- trace
- consequence
- justified inference

GLOBAL simulation does not mean the User knows everything. NPC knowledge is local to each NPC and is not globally shared by default.

## Continuity improvements in v0.2

- duplicate-turn protection prevents one user message from advancing the world twice;
- structured persistent NPC, relationship, event and knowledge state;
- bounded state size so long chats do not grow metadata without limit;
- stable background-event IDs when the model omits an ID;
- hidden/revealed background-event status;
- LOCAL/GLOBAL POV state;
- ongoing off-screen events can advance between user turns;
- no forced drama when nothing meaningful changes;
- existing D100, Action Roll, World Roll, dice veto, Character Autonomy and OCC rules remain authoritative;
- auxiliary runtime failure clears its injection and allows normal ST generation to continue.

## Installation

Install the extension through the SillyTavern third-party extension mechanism or place the folder under the ST third-party extensions directory, then reload ST.

Enable: Maya World/User Runtime -> Enable runtime

Keep Run automatically before normal generation enabled for normal use.

## Important limitation

v0.2 still uses the currently selected SillyTavern connection/profile for the auxiliary User and World calls. The separation is a context/information firewall, not a separate-model architecture.

The extension does not edit presets, MVU, Regex, scripts or other ST configuration. Those are deliberately outside its scope.