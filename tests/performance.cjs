// Reproducible, mock-vault performance baseline. No timings are pass/fail.
// Run: node --expose-gc tests/performance.cjs --measure
// CI runs the same workload via npm test. No real vault or DOM is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const moment = require(require.resolve('moment', {paths: [path.join(root, 'node_modules', 'obsidian')]}));

class TFile {
  constructor(path, text) {
    this.path = path;
    this.stat = {mtime: 1, size: Buffer.byteLength(text)};
  }
}
const obsidian = {
  TFile,
  Component: class {registerEvent() {}},
  moment,
  getFrontMatterInfo(text) {
    const match = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(text);
    return {contentStart: match?.[0].length ?? 0, exists: !!match};
  },
};
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const file = path.join(root, 'src', name + '.ts');
  const module = {exports: {}};
  modules.set(name, module);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + js + '\n})', {
    console, window: {setTimeout, clearTimeout}, performance, Date,
  }, {filename: file})(spec => spec === 'obsidian' ? obsidian : load(path.basename(spec)), module, module.exports);
  return module.exports;
}

const {DailyNoteIndex} = load('noteIndex');
const {FindCorpus} = load('findCorpus');
const {FindResults} = load('findResults');
const {literalExpression, countMatches, findLiteralRanges} = load('findText');
const {JournalStatistics} = load('statistics');
const {DayWalker, ShownDays} = load('dayWalk');

const SIZES = [365, 2000, 10000];
const SAMPLES = 5;
const START = Date.UTC(1970, 0, 1);
function fixture(size) {
  const files = new Map();
  const texts = new Map();
  const keys = [];
  for (let i = 0; i < size; i++) {
    const key = new Date(START + i * 2 * 86400000).toISOString().slice(0, 10);
    const name = 'Journal/' + key + '.md';
    const text = '---\r\nmarker: needle\r\n---\r\n# Day ' + i + '\r\n' +
      'needle A quick brown fox jumps over the lazy dog.\r\n' +
      'A small journal with words, numbers and punctuation. '.repeat(18) +
      '\r\nneedle end\r\n';
    const file = new TFile(name, text);
    files.set(name, file);
    texts.set(name, text);
    keys.push(key);
  }
  let reads = 0;
  const all = [...files.values()].reverse();
  const app = {vault: {
    getMarkdownFiles: () => all,
    getAbstractFileByPath: name => files.get(name) ?? null,
    cachedRead: async file => {reads++; return texts.get(file.path);},
  }};
  return {app, files, keys, reads: () => reads};
}
const config = {folder: 'Journal', format: 'YYYY-MM-DD', multipleNotes: false};
function collect() {
  global.gc();
  return process.memoryUsage().heapUsed;
}
function elapsed(start) {return performance.now() - start;}
async function sample(size) {
  const f = fixture(size);
  const m = {};
  const before = collect();
  let start = performance.now();
  const index = new DailyNoteIndex(f.app, {config: () => config});
  index.rebuild();
  const keys = index.keys();
  m.index_ms = elapsed(start);
  assert.equal(keys.length, size);
  assert.equal(JSON.stringify(keys), JSON.stringify(f.keys));

  const middle = keys[Math.floor(size / 2)];
  const today = moment(middle, 'YYYY-MM-DD', true).startOf('day');
  const walker = new DayWalker(today, index, new ShownDays(index, index, () => null), () => true);
  let offset = 0;
  start = performance.now();
  for (let i = 0; i < 100; i++) {
    offset = walker.next(offset, 1);
    assert.equal(offset, (i + 1) * 2);
  }
  m.navigate_100_ms = elapsed(start);
  start = performance.now();
  for (let i = 0; i < 10; i++) {
    const around = index.keysAround(middle, i % 2 ? -1 : 1);
    assert.equal(around.length, size - 1);
    assert.equal(around[0], keys[Math.floor(size / 2) + (i % 2 ? -1 : 1)]);
  }
  m.around_10_ms = elapsed(start);

  const corpus = new FindCorpus(f.app);
  const release = corpus.retain();
  const ordered = index.keysAround(middle, 1);
  ordered.unshift(middle);
  async function search() {
    const results = new FindResults();
    const expression = literalExpression('needle', false);
    for (const key of ordered) {
      const name = index.pathsFor(key)[0];
      const body = await corpus.read(f.files.get(name));
      assert.ok(body !== null);
      results.set(key, name, 0, countMatches(body, expression), 1);
    }
    assert.equal(results.total, size * 2);
    assert.equal(results.indexOf(results.first(middle), 1), Math.floor(size / 2) * 2);
    const body = await corpus.read(f.files.get(index.pathsFor(middle)[0]));
    const ranges = findLiteralRanges(body, 'needle', false);
    assert.equal(ranges.length, 2);
    for (const range of ranges) assert.equal(body.slice(range.from, range.to), 'needle');
  }
  start = performance.now();
  await search();
  m.search_cold_ms = elapsed(start);
  m.search_cold_reads = f.reads();
  assert.equal(m.search_cold_reads, size);
  start = performance.now();
  await search();
  m.search_warm_ms = elapsed(start);
  m.search_warm_reads = f.reads() - m.search_cold_reads;
  assert.equal(m.search_warm_reads, 0);
  m.search_retained_heap_bytes = collect() - before;

  release();
  corpus.onunload();
  const statistics = new JournalStatistics(f.app);
  const statsBefore = collect();
  const readsBefore = f.reads();
  start = performance.now();
  for (const file of f.files.values()) {
    const value = await statistics.vocabulary(file, () => true);
    assert.equal(value?.status, 'ready');
    assert.ok(value.ids.length > 0);
  }
  m.vocabulary_ms = elapsed(start);
  m.vocabulary_reads = f.reads() - readsBefore;
  assert.equal(m.vocabulary_reads, size);
  m.vocabulary_retained_heap_bytes = collect() - statsBefore;
  statistics.onunload();
  return m;
}
async function measure() {
  console.log('PERF_ENV ' + JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch,
    cpu: require('node:os').cpus()[0]?.model, samples: SAMPLES, timezone: process.env.TZ,
  }));
  for (const size of SIZES) {
    await sample(size); // warmup, not included
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) samples.push(await sample(size));
    const median = {};
    for (const key of Object.keys(samples[0])) {
      median[key] = samples.map(row => row[key]).sort((a, b) => a - b)[Math.floor(SAMPLES / 2)];
    }
    console.log('PERF_RESULT ' + JSON.stringify({size, median, samples}));
  }
}
if (process.argv.includes('--measure')) {
  measure().catch(error => {console.error(error); process.exitCode = 1;});
} else {
  const {test} = require('node:test');
  test('synthetic vault performance and correctness baseline (mocked)', () => {
    console.log(execFileSync(process.execPath, ['--expose-gc', __filename, '--measure'], {
      encoding: 'utf8', env: {...process.env, TZ: 'UTC'}, timeout: 120000,
    }));
  });
}
