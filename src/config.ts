const isProd = import.meta.env.PROD;

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  // En production, utilise l'origine courante (meme hote/port que l'app servie)
  (isProd ? window.location.origin : "http://localhost:3001");
