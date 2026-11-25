const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

const ONLINE_TTL_SEC = 120;
const MAX_MESSAGES = 200;
const KEY_MESSAGES = "shared:messages:v1";
const KEY_NEXT_ID = "shared:next_id:v1";
const KEY_USERS = "shared:users:v1";

const fallbackStore = {
  messages: [],
  nextId: 1,
  users: {}
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

async function readJson(kv, key, defaultVal) {
  if (kv && typeof kv.get === "function") {
    try {
      const val = await kv.get(key, { type: "json" });
      if (val !== null && val !== undefined) return val;
    } catch (_) {}
  }
  return defaultVal;
}

async function writeJson(kv, key, val) {
  if (kv && typeof kv.put === "function") {
    try {
      await kv.put(key, JSON.stringify(val));
      return true;
    } catch (_) {}
  }
  return false;
}

function pruneUsersMap(usersObj) {
  const nowSec = Math.floor(Date.now() / 1000);
  const clean = {};
  const list = [];

  for (const [username, info] of Object.entries(usersObj || {})) {
    if (info && (nowSec - (Number(info.lastSeenSec) || 0)) <= ONLINE_TTL_SEC) {
      clean[username] = info;
      list.push({
        user: info.user,
        displayName: info.displayName,
        userId: info.userId,
        server: info.server
      });
    }
  }
  return { clean, list };
}

async function getAllState(env) {
  const kv = env && env.bin_chat;
  const messages = await readJson(kv, KEY_MESSAGES, fallbackStore.messages);
  const nextIdRaw = await readJson(kv, KEY_NEXT_ID, fallbackStore.nextId);
  const usersRaw = await readJson(kv, KEY_USERS, fallbackStore.users);

  return {
    kv,
    messages: Array.isArray(messages) ? messages : [],
    nextId: Math.max(1, Number(nextIdRaw) || 1),
    users: (usersRaw && typeof usersRaw === "object") ? usersRaw : {}
  };
}

async function saveAllState(state, saveMessages, saveUsers) {
  fallbackStore.messages = state.messages;
  fallbackStore.nextId = state.nextId;
  fallbackStore.users = state.users;

  if (!state.kv) return;
  const tasks = [];
  if (saveMessages) {
    tasks.push(writeJson(state.kv, KEY_MESSAGES, state.messages));
    tasks.push(writeJson(state.kv, KEY_NEXT_ID, state.nextId));
  }
  if (saveUsers) {
    tasks.push(writeJson(state.kv, KEY_USERS, state.users));
  }
  await Promise.all(tasks);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && path === "/messages") {
      const after = Number(url.searchParams.get("after") || "0") || 0;
      const state = await getAllState(env);
      const filtered = state.messages.filter((m) => Number(m.id) > after);
      return jsonResponse({
        ok: true,
        messages: filtered,
        latestId: state.nextId - 1,
        kvEnabled: Boolean(state.kv)
      });
    }

    if (request.method === "POST" && path === "/send") {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
      }

      const user = String(body.user || "Player").slice(0, 40);
      const displayName = String(body.displayName || user).slice(0, 40);
      const userId = Number(body.userId || 0) || 0;
      const text = String(body.text || "").trim().slice(0, 200);
      const server = String(body.server || "Global").slice(0, 32);
      const time = Number(body.time || Math.floor(Date.now() / 1000));

      if (!text) {
        return jsonResponse({ ok: false, error: "Empty text" }, 400);
      }

      const state = await getAllState(env);
      let usersChanged = false;

      if (user && user !== "Player" && user !== "Hệ thống") {
        state.users[user] = {
          user,
          displayName,
          userId,
          server,
          lastSeenSec: Math.floor(Date.now() / 1000)
        };
        usersChanged = true;
      }

      const msg = {
        id: state.nextId++,
        user,
        displayName,
        userId,
        text,
        server,
        time
      };

      state.messages.push(msg);
      if (state.messages.length > MAX_MESSAGES) {
        state.messages.splice(0, state.messages.length - MAX_MESSAGES);
      }

      await saveAllState(state, true, usersChanged);
      return jsonResponse({ ok: true, message: msg });
    }

    if (request.method === "POST" && path === "/ping") {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        body = {};
      }

      const user = String(body.user || "").trim().slice(0, 40);
      const displayName = String(body.displayName || user).slice(0, 40);
      const userId = Number(body.userId || 0) || 0;
      const server = String(body.server || "Global").slice(0, 32);

      const state = await getAllState(env);
      if (user && user !== "Player" && user !== "Hệ thống") {
        state.users[user] = {
          user,
          displayName,
          userId,
          server,
          lastSeenSec: Math.floor(Date.now() / 1000)
        };
      }

      const pruned = pruneUsersMap(state.users);
      state.users = pruned.clean;
      await saveAllState(state, false, true);

      return jsonResponse({
        ok: true,
        online: Math.max(1, pruned.list.length),
        users: pruned.list
      });
    }

    if (request.method === "GET" && path === "/online") {
      const state = await getAllState(env);
      const pruned = pruneUsersMap(state.users);
      state.users = pruned.clean;
      await saveAllState(state, false, true);

      return jsonResponse({
        ok: true,
        online: Math.max(1, pruned.list.length),
        users: pruned.list
      });
    }

    return jsonResponse({
      ok: true,
      service: "Hi Shared KV Worker",
      kvEnabled: Boolean(env && env.hi_chat)
    });
  }
};
