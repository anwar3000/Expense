// Firebase web config for the "expense" project.
// Firebase console → Project settings → General → Your apps → Web app (</>) → SDK setup and configuration → Config.
// Paste the values below, commit, and the app connects.
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

// This email becomes the first admin automatically on first sign-in.
// Must match the email in firestore.rules (function isSuper).
export const SUPER_ADMIN_EMAIL = "anwar@llct.net";

export const CURRENCY = "AED";
// 1 = weeks start Monday, 0 = Sunday, 6 = Saturday
export const WEEK_START = 1;
