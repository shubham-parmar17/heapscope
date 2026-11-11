// api.ts — central API base for local Vite and deployed frontend builds.
// An empty backend URL uses Vite's /api proxy; production can set REACT_APP_BACKEND_URL.
// Keeps frontend network calls on one consistent API origin.
const backendUrl = (import.meta.env.REACT_APP_BACKEND_URL ?? "").replace(/\/+$/, "");

export const API = `${backendUrl}/api`;
