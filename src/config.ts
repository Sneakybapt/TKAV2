const isProd = import.meta.env.PROD;

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (isProd ? "https://the-killer.onrender.com" : "http://localhost:3001");
