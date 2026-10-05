import { ConnectionManagerRequestService } from "../../shared.js";

/*
 * Maya World/User Agent Runtime v0.7.0
 * WORLD_STATE -> PERCEPTION_STATE -> USER_ENGINE firewall.
 *
 * The existing Maya D100 preset remains authoritative for:
 * D100 / Action Roll / World Roll / dice veto / Character Autonomy / OCC / prose.
 * This runtime only supplies context separation and persistent world state.
 */

const MODULE = "maya_world_user_agent";
const META_KEY = "maya_world_user_agent_state";

const DEFAULT = {
    enabled: false,
    autoRun: true,
    historyMessages: 24,
    maxLedgerEntries: 60,
    maxAchievements: 200,
    maxNpcs: 80,
    maxFacts: 120,
    maxVisibleItems: 12,
    maxVisibleEntities: 12,
    maxSensoryItems: 10,
    maxConsequences: 10,
    injectDepth: 2,
    debug: false,
    userProfile: "",
    worldProfile: "",
};

let running = false;
let uiReady = false;
let pendingRuntimeContext = "";

function ctx() { return window.SillyTavern?.getContext?.() || null; }

function settings() {
    const c = ctx();
    const b = c?.extensionSettings?.[MODULE] || {};
    return { ...DEFAULT, ...b };
}

function bag() {
    const c = ctx();
    if (!c) return {};
    c.extensionSettings = c.extensionSettings || {};
    c.extensionSettings[MODULE] = c.extensionSettings[MODULE] || { ...DEFAULT };
    return c.extensionSettings[MODULE];
}

function log(...a) { if (settings().debug) console.log("[MWU]", ...a); }
function warn(...a) { console.warn("[MWU]", ...a); }
function arr(x) { return Array.isArray(x) ? x : []; }
function str(x, n = 1600) { return String(x ?? "").trim().slice(0, n); }
function uniq(x) { return [...new Set(arr(x).map(v => str(v, 1200)).filter(Boolean))]; }

function hash(x) {
    let h = 2166136261;
    const s = String(x ?? "");
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

function freshState() {
    return {
        version: 4,
        turn: 0,
        pov: "LOCAL",
        world: { time: "", location: "", active_events: [] },
        npcs: {},
        relationships: {},
        knowledge: { user: [], npc: {} },
        events: {},
        background_ledger: [],
        achievements: [],
        reveals: [],
        perception: {
            turn: 0,
            pov: "LOCAL",
            time: "",
            location: "",
            visible_context: [],
            visible_entities: [],
            sensory: [],
            immediate_consequences: [],
            known_facts: [],
            recent_reveals: [],
        },
        runtime: { last_user_hash: "", last_user_index: -1 },
    };
}

function migrateState(raw) {
    const s = raw && typeof raw === "object" ? raw : freshState();

    s.world = s.world && typeof s.world === "object" ? s.world : {};
    s.world.time = str(s.world.time, 300);
    s.world.location = str(s.world.location, 500);
    s.world.active_events = uniq(s.world.active_events).slice(0, 20);

    s.npcs = s.npcs && typeof s.npcs === "object" ? s.npcs : {};
    s.relationships = s.relationships && typeof s.relationships === "object" ? s.relationships : {};
    s.events = s.events && typeof s.events === "object" ? s.events : {};

    for (const n of arr(s.world.npc_updates)) {
        const id = str(n?.id || n?.name || ("npc_" + hash(JSON.stringify(n))), 120);
        if (!s.npcs[id]) {
            s.npcs[id] = {
                id,
                role: str(n?.role, 300),
                state: str(n?.state || n?.update || "", 1200),
                location: str(n?.location, 300),
                awareness: Number.isFinite(+n?.awareness) ? Math.max(0, Math.min(5, +n.awareness)) : 0,
                interest: Number.isFinite(+n?.interest) ? Math.max(0, Math.min(5, +n.interest)) : 0,
                knowledge: uniq(n?.knowledge).slice(-20),
                last_update_turn: 0,
            };
        }
    }

    for (const r of arr(s.world.relation_updates)) {
        const a = str(r?.a, 120);
        const b = str(r?.b, 120);
        if (a && b) {
            const key = [a, b].sort().join("::");
            s.relationships[key] = {
                a,
                b,
                change: str(r?.change || r?.update, 800),
                last_update_turn: 0,
            };
        }
    }

    if (!Array.isArray(s.background_ledger)) {
        s.background_ledger = Array.isArray(s.ledger) ? s.ledger : [];
    }

    // Resolved legacy background events become compact historical milestones.
    s.achievements = Array.isArray(s.achievements) ? s.achievements : [];
    for (const e of [...s.background_ledger]) {
        if (e?.status !== "resolved") continue;
        const id = String(e.id || ("achievement_" + hash(JSON.stringify(e))));
        if (!s.achievements.some(a => a.id === id || a.event_id === id)) {
            s.achievements.push({
                id,
                event_id: id,
                title: str(e.title || e.event || "Resolved event", 240),
                summary: str(e.summary || e.current_state || e.event || "A background event was resolved.", 1200),
                when: str(e.when, 200),
                where: str(e.where, 300),
                actors: uniq(e.actors).slice(0, 8),
                consequence: str(e.consequence || e.pending_consequence, 800),
                turn: Number.isFinite(+e.resolved_turn) ? +e.resolved_turn : 0,
            });
        }
        s.background_ledger = s.background_ledger.filter(x => x.id !== e.id);
        if (s.events?.[e.id]?.type === "background") delete s.events[e.id];
    }

    s.knowledge = s.knowledge && typeof s.knowledge === "object" ? s.knowledge : { user: [], npc: {} };
    s.knowledge.user = uniq(s.knowledge.user);
    s.knowledge.npc = s.knowledge.npc && typeof s.knowledge.npc === "object" ? s.knowledge.npc : {};
    s.reveals = arr(s.reveals);
    s.runtime = s.runtime && typeof s.runtime === "object" ? s.runtime : {};
    s.runtime.last_user_hash = str(s.runtime.last_user_hash, 100);
    s.runtime.last_user_index = Number.isFinite(+s.runtime.last_user_index) ? +s.runtime.last_user_index : -1;

    const oldP = s.perception && typeof s.perception === "object" ? s.perception : {};
    s.perception = {
        turn: Number.isFinite(+oldP.turn) ? +oldP.turn : 0,
        pov: oldP.pov === "GLOBAL" ? "GLOBAL" : "LOCAL",
        time: str(oldP.time, 300),
        location: str(oldP.location, 500),
        visible_context: uniq(oldP.visible_context),
        visible_entities: arr(oldP.visible_entities),
        sensory: uniq(oldP.sensory),
        immediate_consequences: uniq(oldP.immediate_consequences),
        known_facts: uniq(oldP.known_facts),
        recent_reveals: arr(oldP.recent_reveals),
    };

    if (!s.perception.recent_reveals.length) {
        s.perception.recent_reveals = s.reveals.slice(-10).map(x => ({
            event_id: str(x?.event_id, 120),
            channel: str(x?.channel, 40),
            text: str(x?.text, 1800),
        }));
    }

    if (!s.perception.known_facts.length) {
        s.perception.known_facts = s.knowledge.user.slice(-Math.max(20, Number(settings().maxFacts) || 120));
    }

    s.version = 4;

    const maxNpcs = Math.max(10, Number(settings().maxNpcs) || 80);
    const maxFacts = Math.max(20, Number(settings().maxFacts) || 120);
    const maxLedger = Math.max(10, Number(settings().maxLedgerEntries) || 60);
    const maxAchievements = Math.max(20, Number(settings().maxAchievements) || 200);

    s.npcs = Object.fromEntries(Object.entries(s.npcs).slice(-maxNpcs));
    s.knowledge.user = s.knowledge.user.slice(-maxFacts);
    s.reveals = s.reveals.slice(-maxFacts);
    s.background_ledger = s.background_ledger.slice(-maxLedger);
    s.achievements = s.achievements.slice(-maxAchievements);

    s.perception.visible_context = s.perception.visible_context.slice(0, Number(settings().maxVisibleItems) || 12);
    s.perception.visible_entities = s.perception.visible_entities.slice(0, Number(settings().maxVisibleEntities) || 12);
    s.perception.sensory = s.perception.sensory.slice(0, Number(settings().maxSensoryItems) || 10);
    s.perception.immediate_consequences = s.perception.immediate_consequences.slice(0, Number(settings().maxConsequences) || 10);
    s.perception.known_facts = s.perception.known_facts.slice(-maxFacts);
    s.perception.recent_reveals = s.perception.recent_reveals.slice(-10);

    return s;
}

function state() {
    const c = ctx();
    if (!c) return null;
    c.chatMetadata = c.chatMetadata || {};
    const s = migrateState(c.chatMetadata[META_KEY]);
    c.chatMetadata[META_KEY] = s;
    return s;
}

function saveState(s) {
    const c = ctx();
    if (!c) return;
    c.chatMetadata = c.chatMetadata || {};
    c.chatMetadata[META_KEY] = s;
    if (typeof c.updateChatMetadata === "function") c.updateChatMetadata({ [META_KEY]: s });
    if (typeof c.saveMetadata === "function") c.saveMetadata();
    else if (typeof c.saveChat === "function") c.saveChat();
}

function persona() {
    const c = ctx();
    try {
        if (typeof c?.substituteParams === "function") return String(c.substituteParams("{{persona}}") || "").trim();
        if (typeof window.substituteParams === "function") return String(window.substituteParams("{{persona}}") || "").trim();
    } catch (e) { log("persona read failed", e); }
    return "";
}

function latestUser() {
    const a = ctx()?.chat || [];
    for (let i = a.length - 1; i >= 0; i--) {
        const m = a[i];
        if (m && (m.is_user === true || m.role === "user")) {
            return { index: i, text: String(m.mes ?? m.content ?? "").trim() };
        }
    }
    return { index: -1, text: "" };
}

function latestAssistant() {
    const a = ctx()?.chat || [];
    for (let i = a.length - 1; i >= 0; i--) {
        const m = a[i];
        if (m && m.is_user !== true && m.role !== "user") {
            const content = String(m.mes ?? m.content ?? "").trim();
            if (content) return { index: i, text: content };
        }
    }
    return { index: -1, text: "" };
}

function history() {
    const a = ctx()?.chat || [];
    const n = Math.max(4, Number(settings().historyMessages) || 24);
    return a.slice(-n).map(m => ({
        role: m?.is_user ? "user" : (m?.role || "assistant"),
        name: m?.name || "",
        content: String(m?.mes ?? m?.content ?? "").slice(0, 5000),
    }));
}

function selectedProfile(kind) {
    return kind === "world" ? String(settings().worldProfile || "") : String(settings().userProfile || "");
}

function getProfiles() {
    try {
        if (ctx()?.extensionSettings?.disabledExtensions?.includes("connection-manager")) return [];
        return ConnectionManagerRequestService.getSupportedProfiles() || [];
    } catch (e) {
        log("connection profiles unavailable", e);
        return [];
    }
}

async function requestViaProfile(profileId, prompt, maxTokens) {
    try {
        const result = await ConnectionManagerRequestService.sendRequest(
            profileId,
            prompt,
            maxTokens,
            {
                stream: false,
                signal: null,
                extractData: true,
                includePreset: false,
                includeInstruct: true,
            },
        );
        const content = typeof result === "string" ? result : (result?.content ?? result?.text ?? "");
        if (!String(content).trim()) throw Error("Selected Connection Profile returned no content.");
        return String(content);
    } catch (e) {
        throw Error("LLM Connection failed: " + (e?.message || e));
    }
}

async function raw(prompt) {
    const profileId = selectedProfile("user");
    if (profileId) return await requestViaProfile(profileId, prompt, 1400);

    const f = ctx()?.generateRaw || window.generateRaw;
    if (typeof f !== "function") throw Error("generateRaw unavailable");
    return await f({ prompt });
}

async function quiet(prompt) {
    const profileId = selectedProfile("world");
    if (profileId) return await requestViaProfile(profileId, prompt, 2200);

    const f = ctx()?.generateRaw || window.generateRaw;
    if (typeof f !== "function") throw Error("generateRaw unavailable");
    return await f({ prompt });
}

function refreshProfileDropdowns() {
    const profiles = getProfiles();
    const buildOptions = (select) => {
        select.empty();
        $("<option>").val("").text("Use current ST connection").appendTo(select);
        for (const profile of profiles) {
            $("<option>").val(profile.id).text(profile.name || profile.id).appendTo(select);
        }
    };
    const user = $("#mwu_user_profile");
    const world = $("#mwu_world_profile");
    if (!user.length || !world.length) return;
    buildOptions(user);
    buildOptions(world);
    user.val(settings().userProfile || "");
    world.val(settings().worldProfile || "");
}

function json(s) {
    s = String(s || "").trim();
    try { return JSON.parse(s); } catch (e) {}
    const m = s.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
    if (m) {
        try { return JSON.parse(m[1]); } catch (e) {}
    }
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) {
        try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {}
    }
    throw Error("Agent returned invalid JSON");
}

function normalizeEntity(x) {
    return {
        id: str(x?.id || x?.name, 120),
        name: str(x?.name || x?.id, 240),
        role: str(x?.role, 240),
        appearance: str(x?.appearance, 700),
        visible_state: str(x?.visible_state || x?.state, 900),
        relation_to_user: str(x?.relation_to_user, 500),
    };
}

function normalizePerception(p) {
    p = p && typeof p === "object" ? p : {};
    return {
        time: str(p.time, 300),
        location: str(p.location, 500),
        visible_context: uniq(p.visible_context).slice(0, Number(settings().maxVisibleItems) || 12),
        visible_entities: arr(p.visible_entities).slice(0, Number(settings().maxVisibleEntities) || 12).map(normalizeEntity).filter(x => x.id || x.name),
        sensory: uniq(p.sensory).slice(0, Number(settings().maxSensoryItems) || 10),
        immediate_consequences: uniq(p.immediate_consequences).slice(0, Number(settings().maxConsequences) || 10),
    };
}

function normWorld(w) {
    w = w && typeof w === "object" ? w : {};
    const p = w.state_patch && typeof w.state_patch === "object" ? w.state_patch : {};
    const perception = normalizePerception(w.perception);

    if (!perception.visible_context.length) {
        perception.visible_context = uniq(w.visible_context).slice(0, Number(settings().maxVisibleItems) || 12);
    }

    const channels = ["witnessed", "heard", "reported", "rumor", "trace", "consequence", "inference"];

    return {
        pov_mode: w.pov_mode === "GLOBAL" ? "GLOBAL" : "LOCAL",
        perception,
        reveals: arr(w.reveals).slice(0, 12).map(x => ({
            event_id: str(x?.event_id, 120),
            channel: channels.includes(x?.channel) ? x.channel : "",
            text: str(x?.text, 1800),
        })).filter(x => x.text && x.channel),
        patch: {
            time: str(p.time, 300),
            location: str(p.location, 500),
            active_events: uniq(p.active_events).slice(0, 20),
            npcs: arr(p.npcs).slice(0, 20).map(x => ({
                id: str(x?.id, 120),
                role: str(x?.role, 300),
                state: str(x?.state, 1200),
                location: str(x?.location, 300),
                knowledge_add: uniq(x?.knowledge_add).slice(0, 8),
                awareness: Number.isFinite(+x?.awareness) ? Math.max(0, Math.min(5, +x.awareness)) : null,
                interest: Number.isFinite(+x?.interest) ? Math.max(0, Math.min(5, +x.interest)) : null,
            })).filter(x => x.id),
            relationships: arr(p.relationships).slice(0, 20).map(x => ({
                a: str(x?.a, 120),
                b: str(x?.b, 120),
                change: str(x?.change, 800),
            })).filter(x => x.a && x.b && x.change),
            events: arr(p.events).slice(0, 20).map(x => ({
                id: str(x?.id, 120) || ("evt_" + hash([x?.state, x?.status].join("|"))),
                status: str(x?.status, 80),
                state: str(x?.state, 1000),
            })),
            background_add: arr(p.background_add).slice(0, 20).map(x => ({
                id: str(x?.id, 120) || ("bg_" + hash([x?.when, x?.where, x?.event].join("|"))),
                when: str(x?.when, 200),
                where: str(x?.where, 300),
                actors: uniq(x?.actors).slice(0, 8),
                event: str(x?.event, 1000),
                current_state: str(x?.current_state, 800),
                pending_consequence: str(x?.pending_consequence, 800),
                reveal_condition: str(x?.reveal_condition, 800),
            })).filter(x => x.event),
            background_resolve: uniq(p.background_resolve).slice(0, 20),
            achievement_add: arr(p.achievement_add).slice(0, 20).map(x => ({
                id: str(x?.id || x?.event_id, 160),
                event_id: str(x?.event_id || x?.id, 160),
                title: str(x?.title, 240),
                summary: str(x?.summary, 1200),
                when: str(x?.when, 200),
                where: str(x?.where, 300),
                actors: uniq(x?.actors).slice(0, 8),
                consequence: str(x?.consequence, 800),
            })).filter(x => x.event_id || x.id || x.summary),
        },
    };
}

function merge(s, w) {
    s.turn = (+s.turn || 0) + 1;
    s.pov = w.pov_mode;

    s.world = s.world || { time: "", location: "", active_events: [] };
    if (w.patch.time) s.world.time = w.patch.time;
    if (w.patch.location) s.world.location = w.patch.location;
    if (w.patch.active_events.length) s.world.active_events = w.patch.active_events;

    s.npcs = s.npcs || {};
    s.relationships = s.relationships || {};
    s.events = s.events || {};
    s.knowledge = s.knowledge || { user: [], npc: {} };
    s.knowledge.npc = s.knowledge.npc || {};

    for (const n of w.patch.npcs) {
        const old = s.npcs[n.id] || { id: n.id, knowledge: [] };
        s.npcs[n.id] = {
            ...old,
            id: n.id,
            role: n.role || old.role || "",
            state: n.state || old.state || "",
            location: n.location || old.location || "",
            awareness: n.awareness ?? old.awareness ?? 0,
            interest: n.interest ?? old.interest ?? 0,
            knowledge: uniq([...(old.knowledge || []), ...n.knowledge_add]).slice(-20),
            last_update_turn: s.turn,
        };
        s.knowledge.npc[n.id] = uniq([...(s.knowledge.npc[n.id] || []), ...n.knowledge_add]).slice(-20);
    }

    for (const r of w.patch.relationships) {
        const key = [r.a, r.b].sort().join("::");
        s.relationships[key] = { a: r.a, b: r.b, change: r.change, last_update_turn: s.turn };
    }

    for (const e of w.patch.events) {
        s.events[e.id] = { ...(s.events[e.id] || {}), ...e, last_update_turn: s.turn };
    }

    s.background_ledger = Array.isArray(s.background_ledger) ? s.background_ledger : [];
    for (const e of w.patch.background_add) {
        const old = s.background_ledger.find(x => x.id === e.id);
        if (old) Object.assign(old, e);
        else s.background_ledger.push({ ...e, status: "hidden", created_turn: s.turn });
        s.events[e.id] ||= { id: e.id, type: "background", status: "hidden" };
    }

    // Resolved background events become compact achievements.
    // Their detailed background records are deleted after promotion.
    const explicitAchievements = new Map(
        w.patch.achievement_add
            .filter(x => x.event_id || x.id)
            .map(x => [x.event_id || x.id, x])
    );

    for (const id of w.patch.background_resolve) {
        const e = s.background_ledger.find(x => x.id === id);
        if (!e) continue;

        const a = explicitAchievements.get(id) || {};
        const achievement = {
            id: str(a.id || ("achievement_" + id), 160),
            event_id: id,
            title: str(a.title || e.title || e.event || "Resolved event", 240),
            summary: str(a.summary || e.summary || e.current_state || e.event || "A background event was resolved.", 1200),
            when: str(a.when || e.when, 200),
            where: str(a.where || e.where, 300),
            actors: uniq([...(e.actors || []), ...(a.actors || [])]).slice(0, 8),
            consequence: str(
                a.consequence || e.pending_consequence
                || "The event is resolved; only its lasting historical significance remains.",
                800
            ),
            turn: s.turn,
        };

        const old = s.achievements.find(x => x.event_id === id);
        if (old) Object.assign(old, achievement);
        else s.achievements.push(achievement);

        // Delete the detailed background record.
        s.background_ledger = s.background_ledger.filter(x => x.id !== id);

        // Delete its transient backend event record as well.
        if (s.events[id]?.type === "background") delete s.events[id];
    }

    s.achievements = s.achievements.slice(
        -Math.max(20, Number(settings().maxAchievements) || 200)
    );

    // Deterministic reveal firewall:
    // - event-backed reveals must reference a known world event;
    // - unbound reveals are limited to direct perception/consequence channels.
    for (const r of w.reveals) {
        const e = r.event_id && s.background_ledger.find(x => x.id === r.event_id);
        const unboundAllowed = ["witnessed", "heard", "consequence"].includes(r.channel);
        if (r.event_id && !e) {
            log("discarding reveal with unknown event id", r.event_id);
            continue;
        }
        if (!r.event_id && !unboundAllowed) {
            log("discarding unbound reveal channel", r.channel);
            continue;
        }
        if (e) e.status = "revealed";
        s.reveals.push({ turn: s.turn, event_id: r.event_id, channel: r.channel, text: r.text });
        s.knowledge.user.push(r.text);
    }

    const p = w.perception;
    s.perception = {
        turn: s.turn,
        pov: w.pov_mode,
        time: p.time || (w.pov_mode === "LOCAL" ? s.world.time : ""),
        location: p.location || (w.pov_mode === "LOCAL" ? s.world.location : ""),
        visible_context: uniq(p.visible_context).slice(0, Number(settings().maxVisibleItems) || 12),
        visible_entities: arr(p.visible_entities).slice(0, Number(settings().maxVisibleEntities) || 12),
        sensory: uniq(p.sensory).slice(0, Number(settings().maxSensoryItems) || 10),
        immediate_consequences: uniq([
            ...p.immediate_consequences,
            ...w.reveals.filter(x => x.channel === "consequence").map(x => x.text),
        ]).slice(0, Number(settings().maxConsequences) || 10),
        known_facts: uniq(s.knowledge.user).slice(-Math.max(20, Number(settings().maxFacts) || 120)),
        recent_reveals: w.reveals.slice(-10),
    };

    return state();
}

function perceivedWorldForUser(s) {
    const p = s?.perception || {};
    return {
        turn: p.turn || 0,
        pov: p.pov === "GLOBAL" ? "GLOBAL" : "LOCAL",
        time: str(p.time, 300),
        location: str(p.location, 500),
        visible_context: uniq(p.visible_context).slice(0, Number(settings().maxVisibleItems) || 12),
        visible_entities: arr(p.visible_entities).slice(0, Number(settings().maxVisibleEntities) || 12),
        sensory: uniq(p.sensory).slice(0, Number(settings().maxSensoryItems) || 10),
        immediate_consequences: uniq(p.immediate_consequences).slice(0, Number(settings().maxConsequences) || 10),
        known_facts: uniq(p.known_facts).slice(-Math.max(20, Number(settings().maxFacts) || 120)),
        recent_reveals: arr(p.recent_reveals).slice(-10),
    };
}

function bootstrapPerception(s) {
    if (s?.perception?.turn > 0 || s?.perception?.visible_context?.length) return;
    const a = latestAssistant();
    if (!a.text) return;

    s.perception = {
        turn: 0,
        pov: "LOCAL",
        time: "",
        location: "",
        visible_context: [a.text.slice(-5000)],
        visible_entities: [],
        sensory: [],
        immediate_consequences: [],
        known_facts: uniq(s.knowledge?.user || []).slice(-Math.max(20, Number(settings().maxFacts) || 120)),
        recent_reveals: [],
    };
}

function inject(v) {
    // Do not alter the preset prompt stack. The context is inserted later
    // into the fully assembled Chat Completion request.
    pendingRuntimeContext = String(v || "");
}



function clear() { pendingRuntimeContext = ""; }

function runtimePrompt(userResult, s) {
    const p = perceivedWorldForUser(s);
    const visibleEntities = arr(p.visible_entities).map(x => [
        x.name || x.id, x.role, x.appearance, x.visible_state, x.relation_to_user
    ].map(v => str(v, 600)).filter(Boolean).join(" | "));

    return "<maya_runtime>\n"
        + "<user_result>\n"
        + "Interpretation: " + str(userResult.user_interpretation, 2200) + "\n"
        + "Explicit actions: " + uniq(userResult.explicit_actions).join(" | ") + "\n"
        + "Explicit dialogue: " + uniq(userResult.explicit_dialogue).join(" | ") + "\n"
        + "</user_result>\n"
        + "<user_perceived_world>\n"
        + "POV: " + p.pov + "\n"
        + "Time: " + p.time + "\n"
        + "Location: " + p.location + "\n"
        + "Visible context: " + uniq(p.visible_context).join(" | ") + "\n"
        + "Visible entities: " + visibleEntities.join(" || ") + "\n"
        + "Sensory: " + uniq(p.sensory).join(" | ") + "\n"
        + "Immediate consequences: " + uniq(p.immediate_consequences).join(" | ") + "\n"
        + "</user_perceived_world>\n"
        + "<rules>"
        + "The User only knows the User Perceived World. "
        + "Hidden WORLD state is not User knowledge. "
        + "Do not invent user choices, dialogue, motives or memories. "
        + "NPC knowledge is local. Continue ongoing events naturally."
        + "</rules>\n"
        + "</maya_runtime>";
}

async function run() {
    const c = ctx();
    const cfg = settings();
    if (!c || !cfg.enabled || running) return false;

    const current = latestUser();
    if (!current.text) return false;

    const s = state();
    bootstrapPerception(s);

    const fingerprint = hash(current.index + "|" + current.text);
    if (s.runtime.last_user_hash === fingerprint && s.runtime.last_user_index === current.index) {
        log("duplicate turn ignored", fingerprint);
        return false;
    }

    running = true;

    try {
        /*
         * HARD FIREWALL:
         * USER PROCESSOR receives Persona + Actual User Input + PERCEPTION_STATE only.
         */
        const up =
            "You are the USER PROCESSOR in a persistent roleplay system.\n"
            + "You are NOT the GM, world simulator, narrator, or NPC manager.\n\n"
            + "USER PERSONA:\n" + persona() + "\n\n"
            + "USER PERCEIVED WORLD:\n" + JSON.stringify(perceivedWorldForUser(s)) + "\n\n"
            + "ACTUAL USER INPUT:\n" + current.text + "\n\n"
            + "Return JSON only:\n"
            + '{"user_interpretation":"...","explicit_actions":["..."],"explicit_dialogue":["..."],"user_state_notes":["..."]}\n\n'
            + "Rules:\n"
            + "- Interpret the real user input inside the supplied perception window.\n"
            + "- Resolve references only from information the User can perceive or already knows.\n"
            + "- Preserve only what the user actually said or clearly implied.\n"
            + "- Never invent a new user decision, intention, dialogue, memory, motive, or emotion.\n"
            + "- Never simulate NPCs, world events, hidden facts, outcomes, or consequences.\n"
            + "- If the input is ambiguous because the perception window lacks enough information, preserve the ambiguity instead of inventing details.";

        globalThis.MayaWorldAgent_auxiliary = true;
        let ur;
        let wr;
        try {
            ur = json(await raw(up));

            const wp =
            "You are the WORLD ENGINE of a persistent roleplay simulation.\n\n"
            + "Advance the world between user turns when causally appropriate. You own:\n"
            + "- time and world state;\n"
            + "- NPC state, knowledge, awareness and interest;\n"
            + "- relationships and events;\n"
            + "- hidden/background events and consequences;\n"
            + "- LOCAL/GLOBAL simulation scope;\n"
            + "- the User-facing perception boundary.\n\n"
            + "The existing preset remains authoritative for D100, Action Roll, World Roll, dice veto, Character Autonomy, OCC and prose. "
            + "This auxiliary WORLD call must NOT replace those systems or secretly decide their final roll outcome.\n\n"
            + "USER_RESULT:\n" + JSON.stringify(ur) + "\n\n"
            + "CURRENT HIDDEN WORLD STATE:\n" + JSON.stringify({
                turn: s.turn,
                pov: s.pov,
                world: s.world,
                npcs: s.npcs,
                relationships: s.relationships,
                events: s.events,
                background_ledger: s.background_ledger,
                achievements: s.achievements,
                knowledge: { npc: s.knowledge.npc },
            }) + "\n\n"
            + "CURRENT USER PERCEPTION:\n" + JSON.stringify(perceivedWorldForUser(s)) + "\n\n"
            + "RECENT CHAT:\n" + JSON.stringify(history()) + "\n\n"
            + "Return JSON only:\n"
            + "{\n"
            + '  "pov_mode":"LOCAL|GLOBAL",\n'
            + '  "perception":{"time":"","location":"","visible_context":[],"visible_entities":[{"id":"","name":"","role":"","appearance":"","visible_state":"","relation_to_user":""}],"sensory":[],"immediate_consequences":[]},\n'
            + '  "reveals":[{"event_id":"optional hidden event id","channel":"witnessed|heard|reported|rumor|trace|consequence|inference","text":"what becomes knowable now"}],\n'
            + '  "state_patch":{"time":"","location":"","active_events":[],"npcs":[{"id":"","role":"","state":"","location":"","knowledge_add":[],"awareness":0,"interest":0}],"relationships":[{"a":"","b":"","change":""}],"events":[{"id":"","status":"","state":""}],"background_add":[{"id":"","when":"","where":"","actors":[],"event":"","current_state":"","pending_consequence":"","reveal_condition":""}],"background_resolve":[],"achievement_add":[{"id":"","event_id":"","title":"","summary":"","when":"","where":"","actors":[],"consequence":""}]}\n'
            + "}\n\n"
            + "Rules:\n"
            + "- WORLD_STATE is the authoritative hidden simulation.\n"
            + "- PERCEPTION is a strict user-facing window, not a dump of WORLD_STATE.\n"
            + "- GLOBAL means broader internal simulation scope; it NEVER means the User learns everything.\n"
            + "- LOCAL is the normal User perception scope when the User's immediate surroundings matter.\n"
            + "- Only put directly perceivable, validly revealed, reported, inferred-from-evidence, or consequential information into perception.\n"
            + "- Never expose hidden motives, secret actions, off-screen events, NPC private knowledge, or backend ledger details merely because the World Engine knows them.\n"
            + "- NPC knowledge is local to each NPC and is never globally shared by default.\n"
            + "- Awareness is not Interest. Attention requires a causal reason.\n"
            + "- Background events remain hidden until a valid reveal channel exists.\n"
            + "- When a background event is fully resolved, include its ID in background_resolve and provide one concise achievement_add summary.\n"
            + "- An achievement is a historical milestone. Keep it general and preserve only durable consequences, not the full event log.\n"
            + "- Once resolved, the detailed background record is deleted by the runtime.\n"
            + "- Never invent a User decision, dialogue, motive, memory, intention, or emotion.\n"
            + "- Do not manufacture drama. If nothing meaningful changes, preserve continuity.\n"
            + "- Continue ongoing off-screen events naturally without narrating them as omniscient prose to the User.\n"
            + "- Do not decide the preset's final D100 result here. Prepare world state and consequences; let the existing preset resolve rolls in the main generation.";

            wr = normWorld(await quiet(wp));
        } finally {
            globalThis.MayaWorldAgent_auxiliary = false;
        }
        merge(s, wr);

        s.runtime.last_user_hash = fingerprint;
        s.runtime.last_user_index = current.index;

        saveState(s);
        inject(runtimePrompt(ur, s));

        log("turn committed", {
            turn: s.turn,
            pov: s.pov,
            visibleEntities: s.perception.visible_entities.length,
            hidden: s.background_ledger.filter(x => x.status === "hidden").length,
        });

        return true;
    } catch (e) {
        warn(e);
        clear();
        return false;
    } finally {
        running = false;
    }
}

function reset() {
    const c = ctx();
    const fresh = freshState();
    if (c?.chatMetadata) c.chatMetadata[META_KEY] = fresh;
    if (typeof c?.updateChatMetadata === "function") c.updateChatMetadata({ [META_KEY]: fresh });
    saveState(fresh);
    clear();
    if (window.toastr?.success) toastr.success("Maya World/User: state reset.");
}

function ui() {
    if (uiReady) return;

    const host =
        document.querySelector("#extensions_settings2")
        || document.querySelector("#extensions_settings");

    if (!host) return;
    uiReady = true;

    const d = document.createElement("div");
    d.className = "mwu-settings inline-drawer";
    d.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header mwu-header">
            <div class="mwu-title-wrap">
                <div class="mwu-title"><span class="mwu-header-icon"><i class="fa-solid fa-globe"></i></span>Maya World/User Runtime</div>
                <div class="mwu-subtitle">WORLD → PERCEPTION → USER • persistent simulation layer</div>
            </div>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>

        <div class="inline-drawer-content mwu-panel">
            <div class="mwu-hero">
                <div>
                    <div class="mwu-kicker">RUNTIME CONTROL</div>
                    <div class="mwu-hero-title">Thế giới sống, ký ức phân tầng</div>
                    <div class="mwu-hero-copy">User chỉ nhận phần thế giới có thể trải nghiệm; WORLD giữ state ẩn và nền sự kiện.</div>
                </div>
                <div id="mwu_runtime_badge" class="mwu-badge mwu-badge-off">OFF</div>
            </div>

            <div class="mwu-stat-grid">
                <div class="mwu-stat"><span>Turn</span><b id="mwu_stat_turn">0</b></div>
                <div class="mwu-stat"><span>POV</span><b id="mwu_stat_pov">LOCAL</b></div>
                <div class="mwu-stat"><span>NPC</span><b id="mwu_stat_npcs">0</b></div>
                <div class="mwu-stat"><span>Live Events</span><b id="mwu_stat_live">0</b></div>
                <div class="mwu-stat"><span>Achievements</span><b id="mwu_stat_achievements">0</b></div>
            </div>

            <div class="mwu-section mwu-accordion mwu-connection-section">
                <button class="mwu-accordion-toggle" type="button" data-mwu-target="connection_body" aria-expanded="false">
                    <span class="mwu-section-head-inline">
                        <span><i class="fa-solid fa-plug"></i></span>
                        <span><b>LLM Connection</b><small>Connection Profile riêng cho USER / WORLD</small></span>
                    </span>
                    <span class="fa-solid fa-chevron-down mwu-accordion-chevron"></span>
                </button>
                <div id="connection_body" class="mwu-accordion-body" hidden>
                    <div class="mwu-field-grid">
                        <label class="mwu-field">
                            <span>USER Processor</span>
                            <select id="mwu_user_profile"></select>
                            <small>Persona + Perception + input thật.</small>
                        </label>
                        <label class="mwu-field">
                            <span>WORLD Engine</span>
                            <select id="mwu_world_profile"></select>
                            <small>WORLD_STATE ẩn + mô phỏng thế giới.</small>
                        </label>
                    </div>
                    <div class="mwu-connection-note">
                        API URL, API Key, Model và generation preset được lấy từ Connection Profile của SillyTavern.
                        Không chọn profile = dùng connection đang active cho chat.
                    </div>
                </div>
            </div>

            <div class="mwu-section mwu-accordion">
                <button class="mwu-accordion-toggle" type="button" data-mwu-target="activity_body" aria-expanded="false">
                    <span class="mwu-section-head-inline"><span>⚙</span><span><b>Hoạt động</b><small>Điều khiển runtime</small></span></span>
                    <span class="fa-solid fa-chevron-down mwu-accordion-chevron"></span>
                </button>
                <div id="activity_body" class="mwu-accordion-body" hidden>
                    <label class="mwu-switch-row">
                        <span><span class="mwu-label">Enable runtime</span><small>Bật lớp WORLD/USER runtime cho chat hiện tại.</small></span>
                        <input id="mwu_enabled" type="checkbox"><span class="mwu-switch"></span>
                    </label>
                    <label class="mwu-switch-row">
                        <span><span class="mwu-label">Auto run</span><small>Chạy USER + WORLD trước mỗi lần generate bình thường.</small></span>
                        <input id="mwu_auto" type="checkbox"><span class="mwu-switch"></span>
                    </label>
                </div>
            </div>

            <div class="mwu-section mwu-accordion">
                <button class="mwu-accordion-toggle" type="button" data-mwu-target="memory_body" aria-expanded="false">
                    <span class="mwu-section-head-inline"><span>◫</span><span><b>Bộ nhớ thế giới</b><small>State sống và lịch sử đã hoàn tất</small></span></span>
                    <span class="fa-solid fa-chevron-down mwu-accordion-chevron"></span>
                </button>
                <div id="memory_body" class="mwu-accordion-body" hidden>
                    <div class="mwu-field-grid">
                    <label class="mwu-field">
                        <span>History</span><input id="mwu_history" type="number" min="4" max="80"><small>Số message gần nhất đưa cho WORLD.</small>
                    </label>
                    <label class="mwu-field">
                        <span>Live ledger</span><input id="mwu_ledger" type="number" min="10" max="200"><small>Số sự kiện nền đang sống tối đa.</small>
                    </label>
                    <label class="mwu-field">
                        <span>Achievements</span><input id="mwu_achievements" type="number" min="20" max="500"><small>Mốc lịch sử đã giải quyết.</small>
                    </label>
                    <label class="mwu-field">
                        <span>NPC max</span><input id="mwu_npcs" type="number" min="10" max="200"><small>Giới hạn NPC được lưu state.</small>
                    </label>
                    <label class="mwu-field">
                        <span>Known facts</span><input id="mwu_facts" type="number" min="20" max="500"><small>Kiến thức User đã hợp lệ biết.</small>
                    </label>
                    </div>
                </div>
            </div>

            <div class="mwu-section mwu-accordion">
                <button class="mwu-accordion-toggle" type="button" data-mwu-target="perception_body" aria-expanded="false">
                    <span class="mwu-section-head-inline"><span>◉</span><span><b>Perception</b><small>Những gì User thực sự được trải nghiệm</small></span></span>
                    <span class="fa-solid fa-chevron-down mwu-accordion-chevron"></span>
                </button>
                <div id="perception_body" class="mwu-accordion-body" hidden>
                    <div class="mwu-field-grid">

                    <div><b>Perception</b><small>Những gì User thực sự được trải nghiệm</small></div>
                </div>
                <div class="mwu-field-grid">
                    <label class="mwu-field">
                        <span>Visible entities</span><input id="mwu_entities" type="number" min="2" max="50"><small>NPC/đối tượng hiện hữu trong tầm nhận biết.</small>
                    </label>
                    <label class="mwu-field">
                        <span>Visible context</span><input id="mwu_visible" type="number" min="4" max="40"><small>Chi tiết môi trường/nhận thức được giữ lại.</small>
                    </label>
                    <label class="mwu-field">
                        <span>Injection depth</span><input id="mwu_depth" type="number" min="0" max="20"><small>Runtime context được chèn vào request sau khi ST dựng xong prompt stack, ngay trước User message hiện tại.</small>
                    </label>
                    </div>
                </div>
            </div>

            <div class="mwu-section mwu-achievement-section">
                <button id="mwu_achievements_toggle" class="mwu-achievement-toggle" type="button" aria-expanded="false">
                    <span class="mwu-section-head-inline">
                        <span>★</span>
                        <span><b>Thành tựu</b><small>Các mốc sự kiện đã hoàn tất</small></span>
                    </span>
                    <span id="mwu_achievements_chevron" class="fa-solid fa-chevron-down"></span>
                </button>
                <div id="mwu_achievements_list" class="mwu-achievement-list" hidden></div>
            </div>

            <div class="mwu-section mwu-knowledge-section">
                <button id="mwu_knowledge_toggle" class="mwu-knowledge-toggle" type="button" aria-expanded="false">
                    <span class="mwu-section-head-inline">
                        <span>◉</span>
                        <span><b>Known Facts</b><small>Tất cả thông tin User hiện đang biết</small></span>
                    </span>
                    <span id="mwu_knowledge_chevron" class="fa-solid fa-chevron-down"></span>
                </button>
                <div id="mwu_knowledge_list" class="mwu-knowledge-list" hidden></div>
            </div>

            <div class="mwu-section mwu-section-tools mwu-accordion">
                <button class="mwu-accordion-toggle" type="button" data-mwu-target="tools_body" aria-expanded="false">
                    <span class="mwu-section-head-inline"><span>⚡</span><span><b>Thao tác</b><small>Chỉ dùng khi cần can thiệp thủ công</small></span></span>
                    <span class="fa-solid fa-chevron-down mwu-accordion-chevron"></span>
                </button>
                <div id="tools_body" class="mwu-accordion-body" hidden>
                    <div class="mwu-buttons">
                    <button id="mwu_run" class="menu_button mwu-primary"><i class="fa-solid fa-play"></i> Run agents now</button>
                    <button id="mwu_reset" class="menu_button mwu-danger"><i class="fa-solid fa-rotate-left"></i> Reset current chat state</button>
                </div>
                    <div class="mwu-note">Reset chỉ xóa state runtime của chat; không xóa lịch sử tin nhắn.</div>
                </div>
            </div>

            <div class="mwu-section mwu-debug-section mwu-accordion">
                <button class="mwu-accordion-toggle" type="button" data-mwu-target="developer_body" aria-expanded="false">
                    <span class="mwu-section-head-inline"><span>⌁</span><span><b>Developer</b><small>Chỉ bật khi đang kiểm tra lỗi</small></span></span>
                    <span class="fa-solid fa-chevron-down mwu-accordion-chevron"></span>
                </button>
                <div id="developer_body" class="mwu-accordion-body" hidden>
                    <label class="mwu-switch-row compact">
                    <span><span class="mwu-label">Debug console</span><small>Ghi log runtime vào DevTools Console.</small></span>
                    <input id="mwu_debug" type="checkbox"><span class="mwu-switch"></span>
                    </label>
                </div>
            </div>

            <div class="mwu-live-status">
                <div class="mwu-live-dot"></div>
                <pre id="mwu_status">Initializing…</pre>
            </div>
        </div>
    `;

    host.appendChild(d);

    const s = settings();

    refreshProfileDropdowns();

    $("#mwu_enabled").prop("checked", s.enabled);
    $("#mwu_auto").prop("checked", s.autoRun);
    $("#mwu_history").val(s.historyMessages);
    $("#mwu_ledger").val(s.maxLedgerEntries);
    $("#mwu_achievements").val(s.maxAchievements);
    $("#mwu_npcs").val(s.maxNpcs);
    $("#mwu_facts").val(s.maxFacts);
    $("#mwu_entities").val(s.maxVisibleEntities);
    $("#mwu_visible").val(s.maxVisibleItems);
    $("#mwu_depth").val(s.injectDepth);
    $("#mwu_debug").prop("checked", s.debug);

    function bind(id, k, cast = v => v) {
        $(id).on("change", function () {
            bag()[k] = cast(this.type === "checkbox" ? this.checked : this.value);
            ctx()?.saveSettingsDebounced?.();
            refreshStatus();
        });
    }

    bind("#mwu_enabled", "enabled");
    bind("#mwu_auto", "autoRun");
    bind("#mwu_history", "historyMessages", Number);
    bind("#mwu_ledger", "maxLedgerEntries", Number);
    bind("#mwu_achievements", "maxAchievements", Number);
    bind("#mwu_npcs", "maxNpcs", Number);
    bind("#mwu_facts", "maxFacts", Number);
    bind("#mwu_entities", "maxVisibleEntities", Number);
    bind("#mwu_visible", "maxVisibleItems", Number);
    bind("#mwu_depth", "injectDepth", Number);
    bind("#mwu_debug", "debug");

    $("#mwu_user_profile").on("change", function () {
        bag().userProfile = String($(this).val() || "");
        ctx()?.saveSettingsDebounced?.();
        refreshStatus();
    });

    $("#mwu_world_profile").on("change", function () {
        bag().worldProfile = String($(this).val() || "");
        ctx()?.saveSettingsDebounced?.();
        refreshStatus();
    });

    if (ctx()?.eventSource && ctx()?.event_types) {
        [
            ctx().event_types.CONNECTION_PROFILE_CREATED,
            ctx().event_types.CONNECTION_PROFILE_UPDATED,
            ctx().event_types.CONNECTION_PROFILE_DELETED,
        ].filter(Boolean).forEach(eventName => ctx().eventSource.on(eventName, refreshProfileDropdowns));
    }

    function refreshStatus() {
        const ss = state();
        const enabled = settings().enabled;
        const badge = $("#mwu_runtime_badge");
        badge.text(enabled ? (running ? "RUNNING" : "ON") : "OFF");
        badge.toggleClass("mwu-badge-off", !enabled && !running);
        badge.toggleClass("mwu-badge-on", enabled && !running);
        badge.toggleClass("mwu-badge-running", running);

        $("#mwu_stat_turn").text(ss?.turn || 0);
        $("#mwu_stat_pov").text(ss?.pov || "LOCAL");
        $("#mwu_stat_npcs").text(Object.keys(ss?.npcs || {}).length);
        $("#mwu_stat_live").text(ss?.background_ledger?.length || 0);
        $("#mwu_stat_achievements").text(ss?.achievements?.length || 0);

        const knowledgeList = $("#mwu_knowledge_list");
        if (knowledgeList.length && !knowledgeList.prop("hidden")) {
            knowledgeList.empty();

            const facts = [...new Set([...(ss?.knowledge?.user || []), ...(ss?.perception?.known_facts || [])])]
                .map(x => String(x || "").trim())
                .filter(Boolean)
                .reverse();

            if (!facts.length) {
                $("<div>")
                    .addClass("mwu-knowledge-empty")
                    .text("User chưa có Known Facts nào được lưu.")
                    .appendTo(knowledgeList);
            } else {
                facts.forEach((fact, index) => {
                    const card = $("<div>").addClass("mwu-knowledge-card");
                    $("<span>").addClass("mwu-knowledge-index").text(String(index + 1)).appendTo(card);
                    $("<div>").addClass("mwu-knowledge-text").text(fact).appendTo(card);
                    card.appendTo(knowledgeList);
                });
            }
        }

        const achievementList = $("#mwu_achievements_list");
        if (achievementList.length && !achievementList.prop("hidden")) {
            achievementList.empty();

            const achievements = [...(ss?.achievements || [])].reverse();
            if (!achievements.length) {
                $("<div>")
                    .addClass("mwu-achievement-empty")
                    .text("Chưa có thành tựu nào được ghi nhận.")
                    .appendTo(achievementList);
            } else {
                for (const a of achievements) {
                    const card = $("<div>").addClass("mwu-achievement-card");
                    $("<div>").addClass("mwu-achievement-title").text(a.title || "Mốc lịch sử").appendTo(card);

                    const meta = [a.when, a.where, ...(a.actors || [])].filter(Boolean).join(" • ");
                    if (meta) $("<div>").addClass("mwu-achievement-meta").text(meta).appendTo(card);

                    $("<div>").addClass("mwu-achievement-summary")
                        .text(a.summary || "Sự kiện đã được hoàn tất.")
                        .appendTo(card);

                    if (a.consequence) {
                        $("<div>").addClass("mwu-achievement-consequence")
                            .text("Hậu quả: " + a.consequence)
                            .appendTo(card);
                    }

                    $("<div>").addClass("mwu-achievement-turn")
                        .text("Mốc runtime: turn " + (a.turn || 0))
                        .appendTo(card);

                    card.appendTo(achievementList);
                }
            }
        }

        $("#mwu_status").text(
            "runtime=" + (enabled ? "enabled" : "disabled")
            + " • auto=" + (settings().autoRun ? "on" : "off")
            + " • turn=" + (ss?.turn || 0)
            + " • pov=" + (ss?.pov || "LOCAL")
            + " • live=" + (ss?.background_ledger?.length || 0)
            + " • achievements=" + (ss?.achievements?.length || 0)
            + " • running=" + running
        );
    }

    $(".mwu-accordion-toggle").on("click", function () {
        const button = $(this);
        const targetId = button.attr("data-mwu-target");
        const body = $("#" + targetId);
        const open = !body.prop("hidden");

        $(".mwu-accordion-body").each(function () {
            if (this.id !== targetId) {
                $(this).prop("hidden", true);
                $(this).closest(".mwu-accordion").find(".mwu-accordion-toggle")
                    .attr("aria-expanded", "false");
                $(this).closest(".mwu-accordion").find(".mwu-accordion-chevron")
                    .removeClass("fa-chevron-up")
                    .addClass("fa-chevron-down");
            }
        });

        body.prop("hidden", open);
        button.attr("aria-expanded", String(!open));
        button.find(".mwu-accordion-chevron")
            .toggleClass("fa-chevron-down", open)
            .toggleClass("fa-chevron-up", !open);
    });

    $("#mwu_achievements_toggle").on("click", function () {
        const open = !$("#mwu_achievements_list").prop("hidden");
        $("#mwu_achievements_list").prop("hidden", open);
        $(this).attr("aria-expanded", String(!open));
        $("#mwu_achievements_chevron")
            .toggleClass("fa-chevron-down", open)
            .toggleClass("fa-chevron-up", !open);
        refreshStatus();
    });

        $("#mwu_knowledge_toggle").on("click", function () {
        const open = !$("#mwu_knowledge_list").prop("hidden");
        $("#mwu_knowledge_list").prop("hidden", open);
        $(this).attr("aria-expanded", String(!open));
        $("#mwu_knowledge_chevron")
            .toggleClass("fa-chevron-down", open)
            .toggleClass("fa-chevron-up", !open);
        refreshStatus();
    });

    $("#mwu_run").on("click", async function () {
        $(this).prop("disabled", true);
        try { await run(); } finally {
            $(this).prop("disabled", false);
            refreshStatus();
        }
    });

    $("#mwu_reset").on("click", function () {
        reset();
        refreshStatus();
    });

    refreshStatus();
    setInterval(refreshStatus, 1500);
}

function init() {
    const c = ctx();
    if (!c) {
        setTimeout(init, 1000);
        return;
    }

    c.extensionSettings = c.extensionSettings || {};
    c.extensionSettings[MODULE] = { ...DEFAULT, ...(c.extensionSettings[MODULE] || {}) };
    c.saveSettingsDebounced?.();

    const t = setInterval(() => {
        if (document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings")) {
            clearInterval(t);
            ui();
        }
    }, 500);

    if (c.eventSource && c.event_types) {
        const e = c.eventSource;
        const t2 = c.event_types;

        // Build USER/WORLD state before ST assembles the final generation prompt.
        e.on(t2.GENERATION_AFTER_COMMANDS, async () => {
            if (globalThis.MayaWorldAgent_auxiliary) return;
            const s = settings();
            if (!s.enabled || !s.autoRun || running) return;
            await run();
        });

        // ST assembles the complete prompt first. Only now add the runtime
        // context, immediately before the current User message. This leaves
        // the preset's thinking chain, D100, word-count and output prompts intact.
        if (t2.CHAT_COMPLETION_PROMPT_READY) {
            e.on(t2.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
                if (globalThis.MayaWorldAgent_auxiliary) return;
                if (eventData?.dryRun || !pendingRuntimeContext || !Array.isArray(eventData?.chat)) return;

                const marker = "MAYA_WORLD_USER_RUNTIME";
                if (eventData.chat.some(m => String(m?.content || "").includes(marker))) return;

                const lastUser = eventData.chat.map((m, i) => ({
                    role: m?.role,
                    i,
                })).reverse().find(x => x.role === "user");

                const message = {
                    role: "system",
                    name: marker,
                    content:
                        "<maya_world_user_runtime>\n"
                        + "SUPPLEMENTAL RUNTIME CONTEXT ONLY. "
                        + "It does not override any enabled preset instruction, reasoning/checklist, D100 rules, word-count rule, output format, character rule, or worldbook rule.\n"
                        + pendingRuntimeContext
                        + "\n</maya_world_user_runtime>",
                };

                const at = lastUser ? lastUser.i : eventData.chat.length;
                eventData.chat.splice(at, 0, message);
                log("runtime context injected into assembled chat", { index: at });
                pendingRuntimeContext = "";
            });
        }

        e.on(t2.GENERATION_ENDED, clear);
        e.on(t2.GENERATION_STOPPED, clear);
        e.on(t2.CHAT_CHANGED, clear);
    }

    console.log("[MWU] v0.7.0 loaded");
}

setTimeout(init, 0);
