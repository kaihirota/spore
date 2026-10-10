const flags = { newCheckout: false, darkMode: true };

export function getFlag(name) {
  return flags[name] ?? false;
}

export function setFlag(name, value) {
  flags[name] = value;
}

export function listFlags() {
  return Object.keys(flags);
}
