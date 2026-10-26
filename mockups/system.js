const formatNumber = (value) => value.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const formatClock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const ref = (name) => document.querySelector(`[data-ref="${name}"]`);
const vibrate = (pattern) => {
  if (navigator.vibrate) navigator.vibrate(pattern);
};

const sportIcons = [
  { id: "lift", label: "Haltère" },
  { id: "kettlebell", label: "Kettlebell" },
  { id: "run", label: "Coureur" },
  { id: "trail", label: "Trail" },
  { id: "walk", label: "Marcheur" },
  { id: "hike", label: "Randonneur" },
  { id: "climb", label: "Grimpeur" },
  { id: "rope", label: "Mousqueton" },
  { id: "alpine", label: "Sommet" },
  { id: "ski", label: "Skieur" },
  { id: "glide", label: "Glisse" },
  { id: "swim", label: "Nageur" },
  { id: "row", label: "Rameur" },
  { id: "paddle", label: "Pagaie" },
  { id: "bike", label: "Vélo" },
  { id: "yoga", label: "Yoga" },
  { id: "dance", label: "Danse" },
  { id: "racket", label: "Raquette" },
  { id: "ball", label: "Ballon" },
  { id: "combat", label: "Gant" },
  { id: "golf", label: "Golf" },
  { id: "other", label: "Chrono" },
];

function sportIcon(id) {
  return `<svg aria-hidden="true" focusable="false"><use href="icons.svg#sport-${id}"/></svg>`;
}

document.querySelectorAll("[data-sport-icon]").forEach((element) => {
  element.innerHTML = sportIcon(element.dataset.sportIcon);
  if (element.dataset.sportLabel) {
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", element.dataset.sportLabel);
  }
});

const journalViews = [
  { id: "list", label: "Liste", href: "journal.html" },
  { id: "calendar", label: "Calendrier", href: "calendar.html" },
  { id: "progress", label: "Progression", href: "progress.html" },
];

document.querySelectorAll("[data-journal-view]").forEach((nav) => {
  nav.innerHTML = journalViews
    .map((view) => `<a href="${view.href}"${view.id === nav.dataset.journalView ? ' aria-current="page"' : ""}>${view.label}</a>`)
    .join("");
});

const tabs = [
  ["today", "Aujourd'hui", '<circle cx="11" cy="11" r="7.5"/><circle cx="11" cy="11" r="2.5"/>'],
  ["journal", "Journal", '<path d="M4 5.5h14M4 11h14M4 16.5h9"/>'],
  ["body", "Corps", '<rect x="3.5" y="3.5" width="15" height="15" rx="3.5"/><path d="M7.5 9a4.5 4.5 0 0 1 7 0M11 9.8l1.4-1.8"/>'],
  ["programs", "Programmes", '<path d="M17.6 8.2A7 7 0 0 0 4.7 7M4.4 13.8a7 7 0 0 0 12.9 1.2"/><path d="M4.2 3.6V7h3.4M17.8 18.4V15h-3.4"/>'],
];

document.querySelectorAll("[data-tabbar]").forEach((nav) => {
  nav.innerHTML = tabs
    .map(([id, label, icon]) => `<a href="${id}.html"${id === nav.dataset.tabbar ? ' aria-current="page"' : ""}><svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>${label}</a>`)
    .join("");
});

const themeColors = { dark: "#14171c", light: "#f6f7f9" };

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => button.setAttribute("aria-pressed", String(theme === "light")));
  document.querySelector("meta[name='theme-color']")?.setAttribute("content", themeColors[theme]);
  localStorage.setItem("obnixe-mockup-theme", theme);
}

document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
  button.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
});
const requestedTheme = new URLSearchParams(location.search).get("theme");
applyTheme(requestedTheme ?? localStorage.getItem("obnixe-mockup-theme") ?? "dark");

function withTheme(href) {
  if (!requestedTheme) return href;
  const url = new URL(href, location.href);
  url.searchParams.set("theme", requestedTheme);
  return url.href;
}
if (requestedTheme) {
  document.querySelectorAll("a[href]").forEach((link) => {
    const url = new URL(link.href);
    if (url.origin !== location.origin) return;
    url.searchParams.set("theme", requestedTheme);
    link.href = url.href;
  });
}

const sheets = new Map([...document.querySelectorAll("[data-sheet]")].map((sheet) => [sheet.dataset.sheet, sheet]));

function setSheet(name, isOpen) {
  const sheet = sheets.get(name);
  sheet.dataset.open = String(isOpen);
  sheet.inert = !isOpen;
}

sheets.forEach((_, name) => setSheet(name, false));
document.querySelectorAll("[data-sheet-close]").forEach((button) => {
  button.addEventListener("click", () => setSheet(button.dataset.sheetClose, false));
});
document.querySelectorAll("[data-sheet-open]").forEach((button) => {
  button.addEventListener("click", () => setSheet(button.dataset.sheetOpen, true));
});

let snackbarTimer = null;
let snackbarAction = null;

function showSnackbar(text, action) {
  const snackbar = ref("snackbar");
  if (!snackbar) return;
  ref("snackbar-text").textContent = text;
  snackbarAction = action;
  const button = ref("snackbar-action");
  button.hidden = action === null;
  if (action) button.textContent = action.label;
  snackbar.dataset.open = "true";
  snackbar.inert = false;
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(hideSnackbar, 10000);
}

function hideSnackbar() {
  const snackbar = ref("snackbar");
  if (snackbar) {
    snackbar.dataset.open = "false";
    snackbar.inert = true;
  }
  snackbarAction = null;
}

if (ref("snackbar")) ref("snackbar").inert = true;
ref("snackbar-action")?.addEventListener("click", () => {
  const action = snackbarAction;
  hideSnackbar();
  action?.run();
});

document.querySelectorAll("[role='switch']").forEach((button) => {
  button.addEventListener("click", () => {
    button.setAttribute("aria-checked", String(button.getAttribute("aria-checked") !== "true"));
    button.dispatchEvent(new CustomEvent("switch", { detail: button.getAttribute("aria-checked") === "true" }));
  });
});

document.querySelectorAll("[data-choice]").forEach((group) => {
  const isOptional = group.dataset.choice === "optional";
  const isMulti = group.dataset.choice === "multi";
  group.querySelectorAll("button").forEach((button) => {
    if (!button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      const wasPressed = button.getAttribute("aria-pressed") === "true";
      if (isMulti) {
        button.setAttribute("aria-pressed", String(!wasPressed));
        const values = [...group.querySelectorAll("button[aria-pressed='true']")].map((item) => item.dataset.value);
        group.dispatchEvent(new CustomEvent("choice", { detail: values }));
        return;
      }
      group.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", "false"));
      button.setAttribute("aria-pressed", String(!(wasPressed && isOptional)));
      group.dispatchEvent(new CustomEvent("choice", { detail: wasPressed && isOptional ? null : button.dataset.value ?? null }));
    });
  });
});
