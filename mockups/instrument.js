const session = {
  startedAt: Date.now() - (32 * 60 + 14) * 1000,
  trackedZones: [{ id: "knee_right", label: "Genou droit" }],
  previousPains: [],
  pains: [],
  exercises: [
    {
      name: "Squat barre",
      equipment: "barre",
      step: 2.5,
      repsMin: 6,
      repsMax: 8,
      restSec: 150,
      restAfterSec: 180,
      rirTarget: 2,
      status: "done",
      zones: [
        { id: "knee_left", label: "Genou gauche" },
        { id: "lower_back", label: "Lombaires" },
        { id: "hip_right", label: "Hanche droite" },
      ],
      sets: [
        { last: { kg: 80, reps: 8, rir: 2 }, done: { kg: 82.5, reps: 8, rir: "2", restSec: null } },
        { last: { kg: 80, reps: 8, rir: 1 }, done: { kg: 82.5, reps: 7, rir: "1", restSec: 162 } },
        { last: { kg: 80, reps: 7, rir: 1 }, done: { kg: 82.5, reps: 7, rir: "1", restSec: 171 } },
      ],
    },
    {
      name: "Développé couché",
      equipment: "barre",
      step: 2.5,
      repsMin: 6,
      repsMax: 10,
      restSec: 120,
      restAfterSec: 150,
      rirTarget: 2,
      status: "active",
      zones: [
        { id: "shoulder_right", label: "Épaule droite" },
        { id: "shoulder_left", label: "Épaule gauche" },
        { id: "elbow_right", label: "Coude droit" },
      ],
      sets: [
        { last: { kg: 57.5, reps: 10, rir: 2 }, done: { kg: 60, reps: 9, rir: "2", restSec: 188 } },
        { last: { kg: 57.5, reps: 10, rir: 1 }, done: { kg: 60, reps: 8, rir: "1", restSec: 131 } },
        { last: { kg: 57.5, reps: 10, rir: 1 }, done: null },
      ],
    },
    {
      name: "Tirage horizontal poulie",
      equipment: "machine",
      step: 5,
      repsMin: 8,
      repsMax: 12,
      restSec: 90,
      restAfterSec: 120,
      rirTarget: 2,
      status: "todo",
      zones: [
        { id: "shoulder_right", label: "Épaule droite" },
        { id: "lower_back", label: "Lombaires" },
        { id: "elbow_right", label: "Coude droit" },
      ],
      sets: [
        { last: { kg: 50, reps: 12, rir: 2 }, done: null },
        { last: { kg: 50, reps: 12, rir: 2 }, done: null },
        { last: { kg: 50, reps: 12, rir: 1 }, done: null },
      ],
    },
    {
      name: "Fentes bulgares",
      equipment: "haltères",
      step: 2,
      repsMin: 8,
      repsMax: 10,
      restSec: 90,
      restAfterSec: 90,
      rirTarget: 2,
      status: "todo",
      zones: [
        { id: "knee_left", label: "Genou gauche" },
        { id: "hip_right", label: "Hanche droite" },
        { id: "lower_back", label: "Lombaires" },
      ],
      sets: [
        { last: { kg: 14, reps: 8, rir: 2 }, done: null },
        { last: { kg: 14, reps: 8, rir: 2 }, done: null },
        { last: { kg: 14, reps: 8, rir: 1 }, done: null },
      ],
    },
    {
      name: "Curl haltères",
      equipment: "haltères",
      step: 2,
      repsMin: 10,
      repsMax: 12,
      restSec: 60,
      restAfterSec: 0,
      rirTarget: 1,
      status: "todo",
      zones: [
        { id: "elbow_right", label: "Coude droit" },
        { id: "elbow_left", label: "Coude gauche" },
        { id: "wrist_right", label: "Poignet droit" },
      ],
      sets: [
        { last: { kg: 12, reps: 12, rir: 1 }, done: null },
        { last: { kg: 12, reps: 11, rir: 1 }, done: null },
      ],
    },
  ],
};

const state = {
  exerciseIndex: 1,
  setIndex: 2,
  finished: false,
  draft: { kg: 0, reps: 0, rir: null },
  editing: null,
  rest: { startedAt: Date.now() - 36 * 1000, totalSec: 120 },
  setStartedAt: null,
};

const limits = { kg: [0, 400], reps: [0, 60] };
let undoSnapshot = null;
let previousBandState = "running";

const currentExercise = () => session.exercises[state.exerciseIndex];
const activeDraft = () => state.editing?.draft ?? state.draft;
const activeSetIndex = () => state.editing?.setIndex ?? state.setIndex;
const hasProgressed = (exercise) => exercise.sets.every((set) => set.last.reps >= exercise.repsMax);
const isPainful = (level) => level === "discomfort" || level === "stop";

function latestLevelByZone() {
  const levels = new Map();
  [...session.previousPains, ...session.pains].forEach((pain) => levels.set(pain.zoneId, pain));
  return levels;
}

function stoppedZonesFor(exercise) {
  const latest = latestLevelByZone();
  return exercise.zones.filter((zone) => latest.get(zone.id)?.level === "stop");
}

function painfulZonesFor(exercise) {
  const latest = latestLevelByZone();
  return exercise.zones.filter((zone) => isPainful(latest.get(zone.id)?.level));
}

const canProgress = (exercise) => hasProgressed(exercise) && painfulZonesFor(exercise).length === 0;

function isProgressionDraft(exercise, setIndex, draft) {
  const last = exercise.sets[setIndex].last;
  return setIndex === 0 && hasProgressed(exercise) && draft.kg === last.kg + exercise.step && draft.reps === exercise.repsMin;
}

function prefillDraft() {
  const exercise = currentExercise();
  const set = exercise.sets[state.setIndex];
  const previous = state.setIndex > 0 ? exercise.sets[state.setIndex - 1].done : null;
  if (previous) {
    state.draft = { kg: previous.kg, reps: previous.reps, rir: null };
  } else if (canProgress(exercise)) {
    state.draft = { kg: set.last.kg + exercise.step, reps: exercise.repsMin, rir: null };
  } else {
    state.draft = { kg: set.last.kg, reps: set.last.reps, rir: null };
  }
}

function sessionTrackedZones() {
  const zones = [...session.trackedZones];
  session.pains.forEach((pain) => {
    if (isPainful(pain.level) && !zones.some((zone) => zone.id === pain.zoneId)) zones.push({ id: pain.zoneId, label: pain.label });
  });
  return zones;
}

function worstLevel(pains) {
  const levels = pains.map((pain) => pain.level);
  if (levels.includes("stop")) return "stop";
  if (levels.includes("discomfort")) return "discomfort";
  return null;
}

function painMark(level) {
  if (!level) return "";
  const label = level === "stop" ? "Arrêt signalé" : "Gêne signalée";
  return `<i class="pain-mark" data-level="${level}" role="img" aria-label="${label}"></i>`;
}

function renderFigure(element, value) {
  const integer = Math.trunc(value);
  const decimal = Math.round((value - integer) * 10);
  element.innerHTML = decimal === 0 ? `${integer}` : `${integer}<span class="decimal">,${decimal}</span>`;
  element.classList.toggle("is-compact", integer >= 100);
}

function describeComparison(exercise, setIndex, draft) {
  const last = exercise.sets[setIndex].last;
  const previousText = `préc. ${formatNumber(last.kg)} × ${last.reps} · RIR ${last.rir}`;
  if (!state.editing && isProgressionDraft(exercise, setIndex, draft)) {
    return { mark: null, lead: `Haut de fourchette : +${formatNumber(exercise.step)} kg`, previousText };
  }
  const painful = painfulZonesFor(exercise);
  const isUntouchedSuspension = setIndex === 0 && hasProgressed(exercise) && painful.length > 0 && draft.kg === last.kg && draft.reps === last.reps;
  if (!state.editing && isUntouchedSuspension) {
    const latest = latestLevelByZone();
    const mark = worstLevel(painful.map((zone) => latest.get(zone.id)));
    return { mark, lead: `Progression suspendue · ${painful.map((zone) => zone.label.toLowerCase()).join(", ")}`, previousText };
  }
  const parts = [];
  const kgDelta = Math.round((draft.kg - last.kg) * 10) / 10;
  const repsDelta = draft.reps - last.reps;
  if (kgDelta !== 0) parts.push(`${kgDelta > 0 ? "+" : "−"}${formatNumber(Math.abs(kgDelta))} kg`);
  if (repsDelta !== 0) parts.push(`${repsDelta > 0 ? "+" : "−"}${Math.abs(repsDelta)} rép.`);
  return { mark: null, lead: parts.length === 0 ? "Comme la dernière fois" : parts.join(" · "), previousText };
}

function renderContext() {
  ref("context").hidden = state.editing !== null;
  ref("editing").hidden = state.editing === null;
  if (state.editing) ref("editing-label").textContent = `Correction de la série ${state.editing.setIndex + 1}`;
}

function renderHeader() {
  const exercise = currentExercise();
  ref("title").textContent = exercise.name;
  ref("target").textContent = `${exercise.sets.length} × ${exercise.repsMin}–${exercise.repsMax} · repos ${formatClock(exercise.restSec)} · RIR ${exercise.rirTarget}`;
  ref("steps").innerHTML = session.exercises
    .map((item, index) => {
      const status = index === state.exerciseIndex && !state.finished ? "now" : item.status === "stopped" ? "stopped" : item.status === "done" ? "done" : "";
      return `<i class="${status}"></i>`;
    })
    .join("");
  ref("steps-label").textContent = `${state.exerciseIndex + 1}/${session.exercises.length}`;

  const stopped = stoppedZonesFor(exercise);
  const showWarning = !state.finished && !state.editing && stopped.length > 0 && exercise.sets.every((set) => !set.done);
  ref("warning").hidden = !showWarning;
  ref("target").hidden = showWarning;
  if (showWarning) {
    ref("warning-text").textContent = `${stopped.map((zone) => zone.label).join(", ")} : arrêt`;
  }
}

function renderTrack() {
  const exercise = currentExercise();
  const track = ref("track");
  track.style.setProperty("--count", String(exercise.sets.length));
  track.classList.toggle("is-scrollable", exercise.sets.length > 4);
  track.innerHTML = exercise.sets
    .map((set, index) => {
      const level = worstLevel(session.pains.filter((pain) => pain.exerciseIndex === state.exerciseIndex && pain.setIndex === index));
      const label = `<span class="set-label">Série ${index + 1}${painMark(level)}</span>`;
      if (set.done?.interrupted) {
        return `<div class="set is-interrupted">${label}<strong>interrompue</strong><small>${formatNumber(set.done.kg)} kg</small></div>`;
      }
      if (set.done) {
        const isEditing = state.editing?.setIndex === index;
        return `<button class="set is-done${isEditing ? " is-editing" : ""}" data-edit-set="${index}" aria-label="Corriger la série ${index + 1}">
          ${label}<strong>${formatNumber(set.done.kg)} × ${set.done.reps}</strong><small>RIR ${set.done.rir ?? "–"}</small>
        </button>`;
      }
      const isCurrent = !state.finished && index === state.setIndex;
      return `<div class="set ${isCurrent ? "is-current" : "is-todo"}">
        ${label}<strong>${isCurrent ? "en cours" : "à faire"}</strong><small>préc. ${formatNumber(set.last.kg)} × ${set.last.reps}</small>
      </div>`;
    })
    .join("");
  track.querySelectorAll("[data-edit-set]").forEach((button) => {
    button.addEventListener("click", () => startEditing(Number(button.dataset.editSet)));
  });
}

function renderReadout() {
  ref("readout").hidden = state.finished;
  ref("finished").hidden = !state.finished;
  if (state.finished) return;

  const exercise = currentExercise();
  const draft = activeDraft();
  renderFigure(ref("kg"), draft.kg);
  renderFigure(ref("reps"), draft.reps);
  ref("kg-unit").textContent = `kg · ${exercise.equipment}`;
  ref("reps-unit").innerHTML = `rép. · obj. <b>${exercise.repsMin}–${exercise.repsMax}</b>`;

  const comparison = describeComparison(exercise, activeSetIndex(), draft);
  ref("comparison").innerHTML = `${painMark(comparison.mark)}<b>${comparison.lead}</b><span> · ${comparison.previousText}</span>`;

  document.querySelectorAll("[data-step]").forEach((button) => {
    const key = button.dataset.key;
    const direction = Number(button.dataset.step);
    const amount = key === "kg" ? exercise.step : 1;
    button.textContent = `${direction > 0 ? "+" : "−"}${formatNumber(amount)}`;
    button.setAttribute("aria-label", `${direction > 0 ? "Ajouter" : "Retirer"} ${formatNumber(amount)} ${key === "kg" ? "kg" : "répétition"}`);
    const [min, max] = limits[key];
    const next = draft[key] + direction * amount;
    button.setAttribute("aria-disabled", String(next < min || next > max));
  });

  document.querySelectorAll("[data-rir]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.rir === draft.rir));
    button.classList.toggle("is-target", button.dataset.rir === String(exercise.rirTarget));
  });
}

function renderUpNext() {
  const upcoming = session.exercises.slice(state.exerciseIndex + 1);
  ref("upnext").hidden = upcoming.length === 0 || state.finished;
  ref("upnext-list").innerHTML = upcoming
    .map((exercise, offset) => {
      const stopped = stoppedZonesFor(exercise);
      const warning = stopped.length > 0 ? `<small class="warn-line">${painMark("stop")}${stopped.map((zone) => zone.label).join(", ")} · arrêt signalé</small>` : "";
      return `<div class="upnext-row"><span>${state.exerciseIndex + offset + 2}</span><span>${exercise.name}${warning}</span><span>${exercise.sets.length} × ${exercise.repsMin}–${exercise.repsMax}</span></div>`;
    })
    .join("");
}

function renderPrimary() {
  const button = ref("primary");
  const label = ref("primary-label");
  if (state.finished) {
    button.dataset.mode = "finish";
    label.textContent = "Faire le bilan de la séance";
  } else if (state.editing) {
    button.dataset.mode = "edit";
    label.textContent = `Corriger la série ${state.editing.setIndex + 1}`;
  } else {
    button.dataset.mode = "validate";
    label.textContent = `Valider la série ${state.setIndex + 1}`;
  }
}

function renderPainButton() {
  const latest = new Map(session.pains.map((pain) => [pain.zoneId, pain]));
  const level = worstLevel([...latest.values()]);
  ref("pain-indicator").innerHTML = painMark(level);
}

function render() {
  renderContext();
  renderHeader();
  renderTrack();
  renderReadout();
  renderUpNext();
  renderPrimary();
  renderPainButton();
  renderBand();
}

function bandState() {
  if (state.finished) return "idle";
  if (state.setStartedAt) return "active";
  if (!state.rest) return "idle";
  const remaining = state.rest.totalSec - Math.floor((Date.now() - state.rest.startedAt) / 1000);
  return remaining > 0 ? "running" : "done";
}

function renderBand() {
  const band = ref("rest");
  const next = bandState();
  if (previousBandState === "running" && next === "done") vibrate([180, 90, 180]);
  previousBandState = next;
  band.dataset.state = next;

  ref("rest-controls").hidden = next !== "running";
  ref("start-controls").hidden = next !== "done";
  ref("start-set").textContent = `Commencer la série ${state.setIndex + 1}`;

  if (next === "running" || next === "done") {
    const elapsed = Math.floor((Date.now() - state.rest.startedAt) / 1000);
    const remaining = state.rest.totalSec - elapsed;
    ref("rest-time").textContent = formatClock(Math.max(0, remaining));
    ref("rest-total").textContent = `/ ${formatClock(state.rest.totalSec)}`;
    ref("rest-over").textContent = formatClock(Math.max(0, -remaining));
    ref("rest-bar").style.transform = `scaleX(${Math.max(0, remaining) / state.rest.totalSec})`;
  }
  if (next === "active") {
    ref("set-elapsed").textContent = formatClock(Math.floor((Date.now() - state.setStartedAt) / 1000));
    ref("set-label").textContent = `Série ${state.setIndex + 1} en cours`;
  }
}

function startRest(totalSec) {
  state.rest = totalSec > 0 ? { startedAt: Date.now(), totalSec } : null;
  state.setStartedAt = null;
  previousBandState = "running";
}

function adjustRest(deltaSec) {
  if (!state.rest) return;
  const elapsed = Math.floor((Date.now() - state.rest.startedAt) / 1000);
  state.rest.totalSec = Math.max(elapsed + 1, state.rest.totalSec + deltaSec);
  renderBand();
}

function startSet() {
  state.setStartedAt = Date.now();
  vibrate(15);
  renderBand();
}

function snapshot() {
  return JSON.stringify({ exercises: session.exercises, pains: session.pains, state });
}

function undoAction() {
  const saved = undoSnapshot;
  return {
    label: "Annuler",
    run: () => {
      if (!saved) return;
      const parsed = JSON.parse(saved);
      session.exercises = parsed.exercises;
      session.pains = parsed.pains;
      Object.assign(state, parsed.state);
      render();
    },
  };
}

function goToNextExercise(restSec) {
  if (state.exerciseIndex === session.exercises.length - 1) {
    state.finished = true;
    state.rest = null;
    state.setStartedAt = null;
    return;
  }
  state.exerciseIndex += 1;
  state.setIndex = 0;
  currentExercise().status = "active";
  prefillDraft();
  startRest(restSec);
}

function validateSet() {
  if (state.finished) {
    location.href = `bilan.html${location.search}`;
    return;
  }
  const exercise = currentExercise();

  if (state.editing) {
    const index = state.editing.setIndex;
    const set = exercise.sets[index];
    set.done = { ...set.done, kg: state.editing.draft.kg, reps: state.editing.draft.reps, rir: state.editing.draft.rir };
    state.editing = null;
    render();
    vibrate(20);
    showSnackbar(`Série ${index + 1} corrigée · ${formatNumber(set.done.kg)} × ${set.done.reps}`, null);
    return;
  }

  undoSnapshot = snapshot();
  const restSec = state.rest && state.setStartedAt ? Math.round((state.setStartedAt - state.rest.startedAt) / 1000) : null;
  exercise.sets[state.setIndex].done = { ...state.draft, restSec };
  const summary = `${formatNumber(state.draft.kg)} × ${state.draft.reps}`;

  if (state.setIndex < exercise.sets.length - 1) {
    state.setIndex += 1;
    prefillDraft();
    startRest(exercise.restSec);
    showSnackbar(`Série ${state.setIndex} enregistrée · ${summary}`, undoAction());
  } else {
    exercise.status = "done";
    goToNextExercise(exercise.restAfterSec);
    showSnackbar(state.finished ? "Séance terminée" : `${exercise.name} terminé · ${summary}`, undoAction());
  }
  vibrate(30);
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startEditing(index) {
  const set = currentExercise().sets[index];
  if (!set.done || set.done.interrupted) return;
  state.editing = { setIndex: index, draft: { kg: set.done.kg, reps: set.done.reps, rir: set.done.rir } };
  render();
}

function leaveEditing() {
  state.editing = null;
  render();
}

function step(key, direction) {
  const draft = activeDraft();
  const amount = key === "kg" ? currentExercise().step : 1;
  const [min, max] = limits[key];
  const next = Math.round((draft[key] + direction * amount) * 10) / 10;
  if (next < min || next > max) return false;
  draft[key] = next;
  vibrate(10);
  renderReadout();
  return true;
}

document.querySelectorAll("[data-step]").forEach((button) => {
  const key = button.dataset.key;
  const direction = Number(button.dataset.step);
  let holdTimer = null;
  let holdStartedAt = 0;
  let lastPointerAt = 0;

  const stopHold = () => clearTimeout(holdTimer);
  const repeat = () => {
    if (!step(key, direction)) return;
    holdTimer = setTimeout(repeat, Date.now() - holdStartedAt > 1400 ? 60 : 160);
  };

  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    lastPointerAt = Date.now();
    holdStartedAt = Date.now();
    step(key, direction);
    holdTimer = setTimeout(repeat, 420);
  });
  button.addEventListener("pointerup", stopHold);
  button.addEventListener("pointerleave", stopHold);
  button.addEventListener("pointercancel", stopHold);
  button.addEventListener("click", () => {
    if (Date.now() - lastPointerAt < 600) return;
    step(key, direction);
  });
});

document.querySelectorAll("[data-rir]").forEach((button) => {
  button.addEventListener("click", () => {
    const draft = activeDraft();
    draft.rir = draft.rir === button.dataset.rir ? null : button.dataset.rir;
    renderReadout();
  });
});

ref("primary").addEventListener("click", validateSet);
ref("editing-leave").addEventListener("click", leaveEditing);
document.querySelectorAll("[data-rest-add]").forEach((button) => {
  button.addEventListener("click", () => adjustRest(Number(button.dataset.restAdd)));
});
ref("rest-skip").addEventListener("click", startSet);
ref("start-set").addEventListener("click", startSet);

function openExerciseSheet() {
  ref("exercise-sheet-title").textContent = currentExercise().name;
  setSheet("exercise", true);
}

ref("title-button").addEventListener("click", openExerciseSheet);
ref("warning-replace").addEventListener("click", openExerciseSheet);

let padKey = "kg";
let padBuffer = "";

function padValue() {
  return padBuffer === "" ? activeDraft()[padKey] : Number(padBuffer.replace(",", "."));
}

function renderPad() {
  const exercise = currentExercise();
  const unit = padKey === "kg" ? "kg" : "rép.";
  ref("pad-title").textContent = padKey === "kg" ? `Charge · ${exercise.equipment}` : "Répétitions";
  const display = ref("pad-value");
  display.textContent = padBuffer === "" ? formatNumber(activeDraft()[padKey]) : padBuffer;
  display.classList.toggle("is-placeholder", padBuffer === "");
  ref("pad-unit").textContent = unit;
  ref("pad-comma").setAttribute("aria-disabled", String(padKey !== "kg" || padBuffer.includes(",")));

  const value = padValue();
  ref("pad-confirm").textContent = `Utiliser ${formatNumber(value)} ${unit}`;
  const last = exercise.sets[activeSetIndex()].last[padKey];
  const delta = Math.round((value - last) * 10) / 10;
  const warning = ref("pad-warning");
  warning.hidden = last === 0 || Math.abs(delta) / last <= 0.2;
  warning.textContent = `${delta > 0 ? "+" : "−"}${formatNumber(Math.abs(delta))} ${unit} vs la dernière fois`;
}

document.querySelectorAll("[data-open-pad]").forEach((button) => {
  button.addEventListener("click", () => {
    padKey = button.dataset.openPad;
    padBuffer = "";
    renderPad();
    setSheet("pad", true);
  });
});

document.querySelectorAll("[data-pad-key]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.padKey;
    if (key === "back") {
      padBuffer = padBuffer.slice(0, -1);
    } else if (key === ",") {
      if (padKey !== "kg" || padBuffer.includes(",")) return;
      padBuffer = `${padBuffer || "0"},`;
    } else {
      const decimals = padBuffer.split(",")[1];
      if (decimals !== undefined && decimals.length >= 1) return;
      if (padBuffer.replace(",", "").length >= 4) return;
      padBuffer = padBuffer === "0" ? key : padBuffer + key;
    }
    vibrate(8);
    renderPad();
  });
});

ref("pad-confirm").addEventListener("click", () => {
  const [min, max] = limits[padKey];
  activeDraft()[padKey] = Math.min(max, Math.max(min, padValue()));
  setSheet("pad", false);
  renderReadout();
});

const pendingPain = new Map();

function painTarget() {
  if (state.editing) {
    return { exerciseIndex: state.exerciseIndex, setIndex: state.editing.setIndex, phase: "edit", label: `Sur la série ${state.editing.setIndex + 1}, en correction` };
  }
  const resting = state.rest !== null && state.setStartedAt === null;
  if (resting) {
    if (state.setIndex > 0) {
      return { exerciseIndex: state.exerciseIndex, setIndex: state.setIndex - 1, phase: "after", label: `Après la série ${state.setIndex} · ${currentExercise().name.toLowerCase()}` };
    }
    if (state.exerciseIndex > 0) {
      const previous = session.exercises[state.exerciseIndex - 1];
      const lastIndex = previous.sets.findLastIndex((set) => set.done);
      if (lastIndex >= 0) {
        return { exerciseIndex: state.exerciseIndex - 1, setIndex: lastIndex, phase: "after", label: `Après la série ${lastIndex + 1} · ${previous.name.toLowerCase()}` };
      }
    }
  }
  return { exerciseIndex: state.exerciseIndex, setIndex: state.setIndex, phase: "during", label: `Pendant la série ${state.setIndex + 1} · ${currentExercise().name.toLowerCase()}` };
}

function painZones() {
  const target = painTarget();
  const exercise = session.exercises[target.exerciseIndex];
  const trackedZones = sessionTrackedZones();
  const tracked = trackedZones.map((zone) => ({ ...zone, tracked: true }));
  const specific = exercise.zones.filter((zone) => !trackedZones.some((item) => item.id === zone.id)).slice(0, 3).map((zone) => ({ ...zone, tracked: false }));
  return [...tracked, ...specific];
}

function renderPainSheet() {
  ref("pain-context").textContent = painTarget().label;
  ref("pain-zones").innerHTML = painZones()
    .map((zone) => {
      const value = pendingPain.get(zone.id) ?? null;
      const levels = zone.tracked ? [["none", "Calme"], ["discomfort", "Gêne"], ["stop", "Arrêt"]] : [["discomfort", "Gêne"], ["stop", "Arrêt"]];
      return `<div class="zone" data-zone="${zone.id}">
        <span class="zone-name">${zone.label}${zone.tracked ? "<small>suivi en cours</small>" : ""}</span>
        <div class="levels" style="--levels:${levels.length}">${levels
          .map(([level, label]) => `<button data-level="${level}" aria-pressed="${value === level}">${label}</button>`)
          .join("")}</div>
      </div>`;
    })
    .join("");
  ref("pain-zones").querySelectorAll("[data-zone]").forEach((zone) => {
    zone.querySelectorAll("[data-level]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = zone.dataset.zone;
        if (pendingPain.get(id) === button.dataset.level) pendingPain.delete(id);
        else pendingPain.set(id, button.dataset.level);
        renderPainSheet();
      });
    });
  });
  ref("pain-save").setAttribute("aria-disabled", String(pendingPain.size === 0));
}

ref("pain-button").addEventListener("click", () => {
  pendingPain.clear();
  ref("pain-step-zones").hidden = false;
  ref("pain-step-stop").hidden = true;
  renderPainSheet();
  setSheet("pain", true);
});

ref("pain-save").addEventListener("click", () => {
  const target = painTarget();
  const zones = painZones();
  const at = Date.now();
  const exercise = currentExercise();
  const hadSuggestion = !state.editing && isProgressionDraft(exercise, state.setIndex, state.draft);
  pendingPain.forEach((level, zoneId) => {
    const zone = zones.find((item) => item.id === zoneId);
    session.pains.push({ zoneId, label: zone.label, level, exerciseIndex: target.exerciseIndex, setIndex: target.setIndex, phase: target.phase, at });
  });
  if (hadSuggestion && !canProgress(exercise)) prefillDraft();
  render();
  const stopped = [...pendingPain.entries()].filter(([, level]) => level === "stop");
  if (stopped.length > 0) {
    ref("pain-stop-title").textContent = `${stopped.map(([zoneId]) => zones.find((zone) => zone.id === zoneId).label).join(", ")} : arrêt`;
    ref("pain-step-zones").hidden = true;
    ref("pain-step-stop").hidden = false;
    return;
  }
  setSheet("pain", false);
  showSnackbar(`Douleur enregistrée · ${target.label.split(" · ")[0].toLowerCase()}`, null);
});

ref("pain-stop-exercise").addEventListener("click", () => {
  const exercise = currentExercise();
  setSheet("pain", false);
  undoSnapshot = snapshot();
  if (!state.editing && state.setStartedAt) {
    const restSec = state.rest ? Math.round((state.setStartedAt - state.rest.startedAt) / 1000) : null;
    exercise.sets[state.setIndex].done = { kg: state.draft.kg, reps: null, rir: null, restSec, startedAt: state.setStartedAt, interrupted: true };
  }
  state.editing = null;
  exercise.status = "stopped";
  goToNextExercise(exercise.restAfterSec);
  render();
  showSnackbar(state.finished ? "Séance terminée · douleur enregistrée" : `${exercise.name} arrêté · douleur enregistrée`, undoAction());
});
ref("pain-stop-replace").addEventListener("click", () => {
  setSheet("pain", false);
  openExerciseSheet();
});
ref("pain-stop-continue").addEventListener("click", () => setSheet("pain", false));

function renderElapsed() {
  ref("elapsed").textContent = formatClock(Math.floor((Date.now() - session.startedAt) / 1000));
}

prefillDraft();
render();
renderElapsed();
setInterval(() => {
  renderBand();
  renderElapsed();
}, 1000);

if (localStorage.getItem("obnixe-mockup-coach") === null) {
  localStorage.setItem("obnixe-mockup-coach", "seen");
  showSnackbar("Maintiens + ou − pour aller vite", { label: "Compris", run: () => {} });
}
