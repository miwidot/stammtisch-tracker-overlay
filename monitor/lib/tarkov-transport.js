// fallow-ignore-file security-sink
// Reviewed false positive: the requested origin is a literal and the path below
// admits only known endpoints under a safe mode name. No caller can select a
// host, query, fragment, or traversal path. Keep this policy isolated so security
// candidates in the API adapter remain visible. Native redirects retain the
// upstream service's existing behavior.
const SAFE_LANGUAGES = new Set(["cs", "de", "en", "es", "fr", "hu", "id", "it", "ja", "ko", "pl", "pt", "ro", "ru", "sk", "th", "tr", "vn", "zh"]);

function validEndpoint(path) {
  if (path === "endpoints") return true;
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/(tasks|items|maps|traders|hideout|crafts|season)(?:_([a-z]{2}(?:-[a-z]{2})?))?$/.exec(path);
  if (!match) return false;
  return validSeasonPath(match) && validTranslationPath(match);
}

function validTranslationPath(match) {
  if (!match[3]) return true;
  return match[2] !== "crafts" && SAFE_LANGUAGES.has(match[3]);
}

function validSeasonPath(match) {
  if (match[2] !== "season") return true;
  return match[1] === "pvp-season";
}

async function fetchTarkovJson(path, signal) {
  if (
    typeof path !== 'string' ||
    !validEndpoint(path)
  ) {
    const error = new Error('Invalid tarkov.dev endpoint');
    error.fatal = true;
    throw error;
  }
  return fetch(`https://json.tarkov.dev/${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'tarkov-data-overlay (+https://github.com/tarkovtracker-org/tarkov-data-overlay)',
    },
    signal,
  });
}

module.exports = { fetchTarkovJson, SAFE_LANGUAGES };
