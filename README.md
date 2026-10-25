# Expense

Web app (installable on phones) for staff to record income and expenses with receipts, against their own account heads. Each user's account is fully isolated; admins see every account, create users and download combined reports.

**Live:** https://anwar3000.github.io/Expense/

## Features
- One screen: current balance, Today / This week / This month / This year totals, head-wise breakdown and the entry list for any period (today, week, month, year, all, custom).
- Income and expense entries: amount, date, account head, payment mode, description, reference, receipts (photos or PDFs).
- Every entry can be edited or deleted at any time; each edit is stamped with who and when.
- Account heads per user (income and expense), with rename and delete. Default heads are added for every new user.
- Opening balance per user.
- Reports for any period/type/head: Excel (Summary, Entries with running balance, By head, Daily, By user), PDF, CSV. Opening b/f and closing balance included.
- Admin: create users (name, email, password, role, opening balance), edit, disable, send password reset, open any user's account to view or correct entries, all-users table with month totals and balances, combined "All users" report.

## One-time setup (Firebase project `expense`)
1. **Authentication** → Get started → enable **Email/Password**. Then *Users → Add user* with `anwar@llct.net` and a password (this is the first admin).
2. **Firestore Database** → Create database (production mode, region `me-central1` or nearest).
3. **Firestore → Rules** → replace everything with the contents of [`firestore.rules`](firestore.rules) → Publish.
4. **Project settings → General → Your apps → Add app → Web (</>)**. Copy the `firebaseConfig` values into [`js/config.js`](js/config.js) and commit.
5. **Authentication → Settings → Authorized domains** → add `anwar3000.github.io`.
6. GitHub repo → **Settings → Pages** → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.

Open the site, sign in as `anwar@llct.net` — the admin account is created automatically. Create staff from the **Users** tab.

## Notes
- Receipts are stored inside Firestore (images auto-compressed, PDFs up to 650 KB), so the free Spark plan is enough — no Cloud Storage/Blaze needed.
- Admin email is set in two places: `js/config.js` (`SUPER_ADMIN_EMAIL`) and `firestore.rules` (`isSuper`). Other admins are made from the Users tab.
- Firebase logins can't be deleted from the browser; disable the user instead (or delete in Firebase console → Authentication).
- Install on a phone: open the site in Chrome/Safari → *Add to Home screen*.
