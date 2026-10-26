const FIXTURE_DAY_MS = 86400000;
const fixtureToday = new Date(2026, 9, 25);

function fixtureDate(iso) {
  const [year, month, date] = iso.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function fixtureIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function fixtureAddDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function fixtureWave(index, seed) {
  return Math.sin(index * 1.73 + seed) * 0.6 + Math.sin(index * 0.61 + seed * 2) * 0.4;
}

function fixtureRound(value, step) {
  return Math.round(value / step) * step;
}

const fixtureGrades = ["4", "5A", "5B", "5C", "6A", "6A+", "6B", "6B+", "6C"];

const fixtureExercises = [
  { id: "squat", name: "Squat barre", block: "A", kind: "load", start: 92, gain: 16, reps: 8, rir: 2, sets: 3, seed: 1, step: 2.5, zone: null },
  { id: "bench", name: "Développé couché", block: "A", kind: "load", start: 68, gain: 13, reps: 9, rir: 2, sets: 3, seed: 2, step: 2.5, zone: "Épaule droite", pressing: true },
  { id: "row-cable", name: "Tirage horizontal poulie", block: "A", kind: "load", start: 56, gain: 14, reps: 10, rir: 2, sets: 3, seed: 3, step: 2.5, zone: null },
  { id: "split-squat", name: "Fentes bulgares", block: "A", kind: "load", start: 15, gain: 6, reps: 8, rir: 2, sets: 3, seed: 4, step: 1, zone: "Genou droit" },
  { id: "curl", name: "Curl haltères", block: "A", kind: "load", start: 13, gain: 4, reps: 10, rir: 1, sets: 2, seed: 5, step: 1, zone: null },
  { id: "rdl", name: "Soulevé de terre roumain", block: "B", kind: "load", start: 84, gain: 20, reps: 8, rir: 2, sets: 3, seed: 6, step: 2.5, zone: null },
  { id: "press", name: "Développé militaire", block: "B", kind: "load", start: 42, gain: 7, reps: 8, rir: 2, sets: 3, seed: 7, step: 2.5, zone: "Épaule droite", pressing: true },
  { id: "pullup", name: "Tractions", block: "B", kind: "reps", start: 5, gain: 4, reps: null, rir: 1, sets: 3, seed: 8, step: 1, zone: null },
  { id: "upright-row", name: "Tirage menton", block: "B", kind: "load", start: 27, gain: 5, reps: 10, rir: 2, sets: 3, seed: 9, step: 2.5, zone: "Épaule droite", pressing: true, retired: "retiré en v7 par Cursor, remplacé par le rowing haltère" },
  { id: "db-row", name: "Rowing haltère", block: "B", kind: "load", start: 0, gain: 0, reps: 10, rir: 2, sets: 3, seed: 10, step: 1, zone: null, added: "ajouté en v7 par Cursor, à la place du tirage menton" },
];

const fixtureLastSets = {
  "2026-10-24": {
    squat: { load: 82.5, reps: 8, rir: 2, sets: 3 },
    bench: { load: 60, reps: 9, rir: 2, sets: 2, interrupted: true },
    "row-cable": { load: 50, reps: 12, rir: 2, sets: 3 },
    "split-squat": { load: 14, reps: 8, rir: 2, sets: 3 },
    curl: { load: 12, reps: 12, rir: 1, sets: 2 },
  },
};

const fixtureProgramEvents = [
  { date: fixtureDate("2026-04-14"), label: "v4", detail: "v4 · Toi", touches: ["bench", "press", "squat"] },
  { date: fixtureDate("2026-10-02"), label: "v5", detail: "v5 · Cursor · footing de 35 à 40 min", touches: ["run"] },
  { date: fixtureDate("2026-10-14"), label: "v6", detail: "v6 · Toi · variante sans matériel", touches: ["rdl", "press", "pullup", "upright-row"] },
  { date: fixtureDate("2026-10-23"), label: "v7", detail: "v7 · Cursor · rowing haltère", touches: ["upright-row", "db-row"] },
];

const fixtureSuspensions = [{ exercise: "bench", from: fixtureDate("2026-10-24"), label: "suspendue · épaule droite" }];

function fixtureSession(iso, data) {
  return { iso, date: fixtureDate(iso), pain: null, ...data };
}

function fixtureExplicitSessions() {
  const liftA = (iso, detail, minutes, pain = null) => fixtureSession(iso, { sport: "lift", block: "A", title: "Séance A · Salle", detail, minutes, href: "session.html", pain });
  const liftB = (iso, detail, minutes, pain = null) => fixtureSession(iso, { sport: "lift", block: "B", title: "Séance B · Salle", detail, minutes, href: "session.html", pain });
  const run = (iso, kind, km, pace, pain = null, note = "") => fixtureSession(iso, { sport: "run", kind, km, pace, title: `Course · ${kind}`, detail: note, minutes: Math.round((km * pace) / 60), href: "session.html?sport=run", pain });
  const climb = (iso, blocs, maxGrade, flashes, minutes, pain = null) => fixtureSession(iso, { sport: "climb", blocs, maxGrade, flashes, title: "Bloc · Arkose Nation", detail: `${blocs} blocs · max ${fixtureGrades[maxGrade]}${flashes ? ` · ${flashes} flash` : ""}`, minutes, href: "session.html?sport=climb", pain });
  return [
    liftA("2026-09-01", "15 séries · modéré", 58),
    run("2026-09-03", "footing", 7, 324),
    climb("2026-09-05", 8, 5, 2, 90),
    run("2026-09-07", "footing", 7.5, 321),
    liftB("2026-09-08", "15 séries · modéré", 55),
    liftA("2026-09-10", "15 séries · dur", 60),
    climb("2026-09-12", 10, 6, 3, 95),
    liftB("2026-09-15", "14 séries · dur", 54, { zone: "Épaule droite", level: "discomfort" }),
    fixtureSession("2026-09-19", { sport: "hike", km: 18.2, title: "Rando · forêt de Rambouillet", detail: "D+ 310 m", minutes: 250, href: "session.html?sport=run" }),
    run("2026-09-21", "footing", 6, 330, { zone: "Genou droit", level: "discomfort" }),
    liftA("2026-09-22", "15 séries · dur", 59),
    liftB("2026-09-24", "15 séries · modéré", 53),
    climb("2026-09-26", 9, 6, 2, 85),
    run("2026-09-28", "footing", 7, 318),
    liftA("2026-09-29", "15 séries · dur", 61),
    liftB("2026-10-01", "15 séries · modéré", 52),
    climb("2026-10-03", 8, 5, 2, 90),
    run("2026-10-04", "footing", 8, 316),
    liftA("2026-10-06", "15 séries · dur", 57),
    run("2026-10-08", "footing", 8, 314),
    fixtureSession("2026-10-10", { sport: "bike", km: 32, title: "Vélo · route", detail: "24,6 km/h", minutes: 78, href: "session.html?sport=run" }),
    run("2026-10-12", "fractionné", 9.2, 310, null, "6 × 800 m · ajoutée par Cursor"),
    liftA("2026-10-14", "15 séries · dur", 61),
    fixtureSession("2026-10-16", { sport: "swim", meters: 1500, title: "Natation · crawl", detail: "2:08 /100 m", minutes: 32, href: "session.html?sport=run" }),
    fixtureSession("2026-10-18", { sport: "hike", km: 21.4, title: "Rando · vallée de Chevreuse", detail: "D+ 640 m · sac 7 kg", minutes: 360, href: "session.html?sport=run" }),
    climb("2026-10-19", 9, 6, 3, 80, { zone: "Doigts, main droite", level: "discomfort" }),
    liftB("2026-10-20", "15 séries · modéré", 54, { zone: "Épaule droite", level: "discomfort" }),
    run("2026-10-22", "footing", 8, 312, null, "genou calme"),
    liftA("2026-10-24", "13 séries · dur", 58, { zone: "Épaule droite", level: "stop" }),
  ];
}

function fixtureHistorySessions() {
  const sessions = [];
  const first = fixtureDate("2025-11-03");
  const last = fixtureDate("2026-08-30");
  let week = 0;
  for (let monday = first; monday <= last; monday = fixtureAddDays(monday, 7), week += 1) {
    const iso = fixtureIso(monday);
    const isBreak = (iso >= "2025-12-21" && iso <= "2026-01-04") || (iso >= "2026-08-10" && iso <= "2026-08-23");
    const isInjured = iso >= "2026-07-13" && iso <= "2026-08-30";
    if (isBreak) continue;
    sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 1)), { sport: "lift", block: "A", title: "Séance A · Salle", detail: "15 séries", minutes: 56 + (week % 5), href: "session.html" }));
    sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 3)), { sport: "lift", block: "B", title: "Séance B · Salle", detail: "15 séries", minutes: 52 + (week % 4), href: "session.html" }));
    const pace = Math.round(352 - (week / 43) * 24 + fixtureWave(week, 4) * 5);
    if (isInjured) {
      if (iso === "2026-07-13") sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 1 + 1)), { sport: "run", kind: "footing", km: 6, pace: 340, title: "Course · footing", detail: "", minutes: 34, href: "session.html?sport=run", pain: { zone: "Genou droit", level: "discomfort" } }));
      if (iso === "2026-07-20") sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 1 + 1)), { sport: "run", kind: "footing", km: 3, pace: 350, title: "Course · footing", detail: "arrêtée au 3e km", minutes: 18, href: "session.html?sport=run", pain: { zone: "Genou droit", level: "stop" } }));
      if (iso === "2026-08-03") sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 6)), { sport: "run", kind: "footing", km: 4, pace: 345, title: "Course · footing", detail: "reprise", minutes: 23, href: "session.html?sport=run", pain: { zone: "Genou droit", level: "discomfort" } }));
      if (iso === "2026-08-24") sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 6)), { sport: "run", kind: "footing", km: 5, pace: 330, title: "Course · footing", detail: "genou calme", minutes: 28, href: "session.html?sport=run" }));
    } else {
      const sundayKm = fixtureRound(9 + fixtureWave(week, 1) * 2.5, 0.5);
      sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 6)), { sport: "run", kind: "footing", km: sundayKm, pace, title: "Course · footing", detail: "", minutes: Math.round((sundayKm * pace) / 60), href: "session.html?sport=run" }));
      if (week % 3 !== 2) {
        const wednesdayKm = fixtureRound(7 + fixtureWave(week, 5) * 1.5, 0.5);
        const kind = week % 2 === 0 ? "fractionné" : "footing";
        sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 2)), { sport: "run", kind, km: wednesdayKm, pace: kind === "fractionné" ? pace - 25 : pace, title: `Course · ${kind}`, detail: "", minutes: Math.round((wednesdayKm * pace) / 60), href: "session.html?sport=run" }));
      }
    }
    if (week % 2 === 0) {
      const maxGrade = Math.min(6, Math.max(3, Math.round(3.2 + (week / 43) * 2.3 + fixtureWave(week, 6) * 0.6)));
      const blocs = 7 + (week % 4);
      sessions.push(fixtureSession(fixtureIso(fixtureAddDays(monday, 5)), { sport: "climb", blocs, maxGrade, flashes: 2 + (week % 3), title: "Bloc · Arkose Nation", detail: `${blocs} blocs · max ${fixtureGrades[maxGrade]}`, minutes: 80 + (week % 3) * 5, href: "session.html?sport=climb" }));
    }
  }
  return sessions;
}

function fixtureAttachStrength(sessions) {
  fixtureExercises.forEach((exercise) => {
    if (exercise.added) return;
    const dated = sessions.filter((session) => session.sport === "lift" && session.block === exercise.block);
    dated.forEach((session, index) => {
      session.sets = session.sets ?? {};
      const override = fixtureLastSets[session.iso]?.[exercise.id];
      if (override) {
        session.sets[exercise.id] = override;
        return;
      }
      const progress = (index / Math.max(dated.length - 1, 1)) ** 0.85;
      if (exercise.kind === "reps") {
        session.sets[exercise.id] = { load: 0, reps: Math.max(3, Math.round(exercise.start + exercise.gain * progress + fixtureWave(index, exercise.seed))), rir: exercise.rir, sets: exercise.sets };
        return;
      }
      const strength = exercise.start + exercise.gain * progress + fixtureWave(index, exercise.seed) * exercise.start * 0.025;
      const reps = exercise.reps - (index % 4 === 1 ? 1 : 0);
      const load = fixtureRound(strength / (1 + (reps + exercise.rir) / 30), exercise.step);
      session.sets[exercise.id] = { load, reps, rir: exercise.rir, sets: exercise.sets };
    });
  });
}

const fixtureSessions = [...fixtureHistorySessions(), ...fixtureExplicitSessions()].sort((a, b) => a.date - b.date);
fixtureAttachStrength(fixtureSessions);

const fixtureCheckins = (() => {
  const explicit = {
    "2026-10-24": { energy: 4, sleep: 7, zones: { "Épaule droite": "stop", "Genou droit": "none" } },
    "2026-10-23": { energy: 3, sleep: 6, zones: { "Genou droit": "discomfort" } },
    "2026-10-22": { energy: 4, sleep: 8, zones: { "Genou droit": "none" } },
    "2026-10-21": { energy: 2, sleep: 5.5, zones: { "Épaule droite": "discomfort", "Genou droit": "none" } },
  };
  const checkins = [];
  for (let date = fixtureDate("2026-08-31"); date < fixtureToday; date = fixtureAddDays(date, 1)) {
    const iso = fixtureIso(date);
    const index = Math.round((date - fixtureDate("2026-08-31")) / FIXTURE_DAY_MS);
    if (explicit[iso]) {
      checkins.push({ iso, date, ...explicit[iso] });
      continue;
    }
    if (index % 3 === 2) continue;
    const knee = iso === "2026-09-22" ? "discomfort" : "none";
    checkins.push({ iso, date, energy: Math.max(2, Math.min(5, Math.round(3.6 + fixtureWave(index, 2)))), sleep: Math.round((7 + fixtureWave(index, 7) * 0.9) * 2) / 2, zones: { "Genou droit": knee } });
  }
  return checkins;
})();

const fixtureWeighins = (() => {
  const explicit = { "2026-10-19": 74.9, "2026-10-20": 75.1, "2026-10-22": 74.7, "2026-10-23": 74.8 };
  const weighins = [];
  for (let date = fixtureDate("2025-11-02"); date < fixtureDate("2026-10-19"); date = fixtureAddDays(date, 3)) {
    const index = Math.round((date - fixtureDate("2025-11-02")) / FIXTURE_DAY_MS);
    weighins.push({ iso: fixtureIso(date), date, kg: Math.round((76.4 - (index / 350) * 1.4 + fixtureWave(index / 3, 3) * 0.35) * 10) / 10 });
  }
  Object.entries(explicit).forEach(([iso, kg]) => weighins.push({ iso, date: fixtureDate(iso), kg }));
  return weighins.sort((a, b) => a.date - b.date);
})();

function fixturePains(zone) {
  const fromSessions = fixtureSessions.filter((session) => session.pain?.zone === zone).map((session) => ({ date: session.date, level: session.pain.level, source: "session" }));
  const fromCheckins = fixtureCheckins
    .filter((checkin) => checkin.zones[zone] && checkin.zones[zone] !== "none")
    .map((checkin) => ({ date: checkin.date, level: checkin.zones[zone], source: "checkin" }));
  return [...fromSessions, ...fromCheckins].sort((a, b) => a.date - b.date);
}

function fixtureMonday(date) {
  return fixtureAddDays(date, -((date.getDay() + 6) % 7));
}
