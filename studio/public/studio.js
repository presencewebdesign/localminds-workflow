(() => {
  const ENTITY_LISTS = {
    skill: 'skills',
    agent: 'agents',
    prompt: 'prompts',
    instruction: 'instructions',
    workflow: 'workflows',
  };
  const STEP_TYPES = ['skill', 'agent', 'prompt', 'instruction', 'parallel', 'loop'];
  const TOOLS = ['edit', 'terminal', 'search', 'memory', 'web'];

  const state = {
    root: '',
    dir: '',
    library: emptyLibrary(),
    dirty: false,
    selection: null,
    tab: 'fields',
    compile: { ir: null, error: null },
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    repo: $('repo-path'),
    saveState: $('save-state'),
    empty: $('empty'),
    editor: $('editor'),
    meta: $('meta'),
    workflowBody: $('workflow-body'),
    stepTree: $('step-tree'),
    stage: $('stage'),
    fields: $('fields'),
    jsonEditor: $('json-editor'),
    compileStatus: $('compile-status'),
    toast: $('toast'),
  };

  function emptyLibrary() {
    return { instructions: [], agents: [], skills: [], prompts: [], workflows: [] };
  }

  function toast(message, kind = '') {
    els.toast.hidden = false;
    els.toast.className = kind;
    els.toast.id = 'toast';
    els.toast.textContent = message;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function markDirty(dirty = true) {
    state.dirty = dirty;
    els.saveState.textContent = dirty ? 'Unsaved' : 'Saved';
    els.saveState.className = 'state' + (dirty ? ' dirty' : ' ok');
  }

  function slugify(value, fallback) {
    const slug = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || fallback;
  }

  function uniqueSlug(list, base) {
    const used = new Set(list.map((item) => item.slug));
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    return slug;
  }

  function uniqueStepId(workflow, base) {
    const used = new Set();
    const walk = (steps) => {
      for (const step of steps || []) {
        used.add(step.id);
        walk(step.steps);
      }
    };
    walk(workflow.steps);
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    return id;
  }

  function collection(kind) {
    return state.library[ENTITY_LISTS[kind]];
  }

  function selectedWorkflow() {
    if (!state.selection) return null;
    const slug = state.selection.kind === 'workflow'
      ? state.selection.slug
      : state.selection.workflowSlug;
    return state.library.workflows.find((w) => w.slug === slug) || null;
  }

  function stepAt(workflow, path) {
    let list = workflow.steps;
    let step = null;
    for (const index of path) {
      step = list[index];
      if (!step) return null;
      list = step.steps || [];
    }
    return step;
  }

  function setSelection(selection) {
    state.selection = selection;
    render();
    if (selection && (selection.kind === 'workflow' || selection.kind === 'step')) {
      compileCurrent();
    }
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed: ${res.status}`);
    return data;
  }

  async function loadProject() {
    const data = await api('/api/project');
    state.root = data.root;
    state.dir = data.dir;
    state.library = data.library;
    els.repo.textContent = data.dir;
    markDirty(false);
    const first = data.library.workflows[0] || data.library.skills[0];
    state.selection = first
      ? { kind: first.steps ? 'workflow' : first.kind, slug: first.slug }
      : null;
    render();
    if (state.selection && state.selection.kind === 'workflow') compileCurrent();
  }

  async function saveProject() {
    const data = await api('/api/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library: state.library }),
    });
    state.library = data.library;
    markDirty(false);
    toast(`Wrote ${data.dir}`, 'ok');
    render();
  }

  async function compileCurrent() {
    const workflow = selectedWorkflow();
    if (!workflow) {
      state.compile = { ir: null, error: null };
      renderGraph();
      return;
    }
    try {
      const data = await api('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow }),
      });
      state.compile = { ir: data.ir, error: null };
      els.compileStatus.textContent = `${data.ir.nodes.length} nodes`;
      els.compileStatus.className = 'state ok';
    } catch (err) {
      state.compile = { ir: null, error: err.message };
      els.compileStatus.textContent = 'Invalid';
      els.compileStatus.className = 'state fail';
    }
    renderGraph();
  }

  function addEntity(kind) {
    if (kind === 'workflow') {
      const slug = uniqueSlug(state.library.workflows, 'untitled');
      const workflow = {
        id: slug,
        slug,
        name: 'Untitled workflow',
        description: '',
        autoApply: false,
        steps: [],
      };
      state.library.workflows.push(workflow);
      markDirty();
      setSelection({ kind: 'workflow', slug });
      return;
    }
    const list = collection(kind);
    const slug = uniqueSlug(list, `new-${kind}`);
    const entity = { kind, slug, name: `New ${kind}`, description: '', body: '' };
    if (kind === 'skill' || kind === 'agent') {
      entity.mode = 'ask';
      entity.tools = [];
    }
    if (kind === 'skill') entity.activation = { mode: 'on-demand' };
    if (kind === 'instruction') entity.scope = 'manual';
    if (kind === 'prompt') entity.arguments = [];
    list.push(entity);
    markDirty();
    setSelection({ kind, slug });
  }

  function removeSelected() {
    const sel = state.selection;
    if (!sel) return;
    if (sel.kind === 'step') {
      const workflow = selectedWorkflow();
      const parentPath = sel.path.slice(0, -1);
      const index = sel.path[sel.path.length - 1];
      const parent = parentPath.length ? stepAt(workflow, parentPath) : null;
      const list = parent ? (parent.steps || []) : workflow.steps;
      list.splice(index, 1);
      markDirty();
      setSelection({ kind: 'workflow', slug: workflow.slug });
      return;
    }
    const list = collection(sel.kind);
    const idx = list.findIndex((item) => item.slug === sel.slug);
    if (idx >= 0) list.splice(idx, 1);
    markDirty();
    setSelection(null);
  }

  function addStep(parentPath) {
    const workflow = selectedWorkflow();
    if (!workflow) return;
    const parent = parentPath.length ? stepAt(workflow, parentPath) : null;
    const list = parent ? (parent.steps ||= []) : workflow.steps;
    const id = uniqueStepId(workflow, 'step');
    list.push({ id, type: 'skill', ref: '', input: '' });
    markDirty();
    const path = parentPath.concat(list.length - 1);
    setSelection({ kind: 'step', workflowSlug: workflow.slug, path });
  }

  function moveStep(path, dir) {
    const workflow = selectedWorkflow();
    const parentPath = path.slice(0, -1);
    const index = path[path.length - 1];
    const parent = parentPath.length ? stepAt(workflow, parentPath) : null;
    const list = parent ? parent.steps : workflow.steps;
    const next = index + dir;
    if (next < 0 || next >= list.length) return;
    const [item] = list.splice(index, 1);
    list.splice(next, 0, item);
    markDirty();
    setSelection({ kind: 'step', workflowSlug: workflow.slug, path: parentPath.concat(next) });
  }

  function mergeExample(example) {
    for (const [kind, key] of Object.entries(ENTITY_LISTS)) {
      if (kind === 'workflow') continue;
      const incoming = example[key] || [];
      for (const item of incoming) {
        if (!collection(kind).some((existing) => existing.slug === item.slug)) {
          collection(kind).push(item);
        }
      }
    }
    for (const workflow of example.workflows || []) {
      if (!state.library.workflows.some((existing) => existing.slug === workflow.slug)) {
        state.library.workflows.push(workflow);
      }
    }
    markDirty();
    const first = (example.workflows || [])[0];
    setSelection(first ? { kind: 'workflow', slug: first.slug } : state.selection);
    toast('Example library merged into this project', 'ok');
  }

  function selectedPayload() {
    const sel = state.selection;
    if (!sel) return state.library;
    if (sel.kind === 'step') return stepAt(selectedWorkflow(), sel.path);
    if (sel.kind === 'workflow') return selectedWorkflow();
    return collection(sel.kind).find((item) => item.slug === sel.slug);
  }

  function applyJson() {
    let parsed;
    try {
      parsed = JSON.parse(els.jsonEditor.value);
    } catch (err) {
      toast(`JSON error: ${err.message}`, 'fail');
      return;
    }
    const sel = state.selection;
    if (!sel) {
      state.library = {
        ...emptyLibrary(),
        ...parsed,
      };
    } else if (sel.kind === 'workflow') {
      const list = state.library.workflows;
      const idx = list.findIndex((item) => item.slug === sel.slug);
      if (idx >= 0) {
        list[idx] = parsed;
        sel.slug = parsed.slug;
      }
    } else if (sel.kind === 'step') {
      const workflow = selectedWorkflow();
      const parentPath = sel.path.slice(0, -1);
      const index = sel.path[sel.path.length - 1];
      const parent = parentPath.length ? stepAt(workflow, parentPath) : null;
      const list = parent ? parent.steps : workflow.steps;
      list[index] = parsed;
    } else {
      const list = collection(sel.kind);
      const idx = list.findIndex((item) => item.slug === sel.slug);
      if (idx >= 0) {
        list[idx] = parsed;
        sel.slug = parsed.slug;
      }
    }
    markDirty();
    render();
    compileCurrent();
    toast('JSON applied', 'ok');
  }

  function renderSidebar() {
    const renderList = (kind) => {
      const ul = $(`list-${ENTITY_LISTS[kind]}`);
      ul.replaceChildren();
      const items = collection(kind);
      if (!items.length) {
        const note = document.createElement('div');
        note.className = 'empty-note';
        note.textContent = 'None yet';
        ul.appendChild(note);
        return;
      }
      for (const item of items) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'item';
        if (state.selection && state.selection.kind === kind && state.selection.slug === item.slug) {
          btn.classList.add('on');
        }
        if (kind === 'workflow' && state.selection && state.selection.kind === 'step' && state.selection.workflowSlug === item.slug) {
          btn.classList.add('on');
        }
        btn.textContent = item.name || item.slug;
        btn.addEventListener('click', () => setSelection({ kind, slug: item.slug }));
        li.appendChild(btn);
        ul.appendChild(li);
      }
    };
    ['workflow', 'skill', 'agent', 'prompt', 'instruction'].forEach(renderList);
  }

  function field(label, control, span = false) {
    const wrap = document.createElement('label');
    wrap.className = 'field' + (span ? ' span' : '');
    const caption = document.createElement('span');
    caption.textContent = label;
    wrap.append(caption, control);
    return wrap;
  }

  function input(value, onChange, opts = {}) {
    const el = document.createElement(opts.area ? 'textarea' : opts.options ? 'select' : 'input');
    if (!opts.area && !opts.options) el.type = opts.type || 'text';
    if (opts.options) {
      for (const opt of opts.options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === value) o.selected = true;
        el.appendChild(o);
      }
    } else {
      el.value = value == null ? '' : String(value);
    }
    if (opts.placeholder) el.placeholder = opts.placeholder;
    const emit = () => onChange(el.value);
    el.addEventListener('input', emit);
    el.addEventListener('change', emit);
    return el;
  }

  function renderMeta() {
    els.meta.replaceChildren();
    const sel = state.selection;
    if (!sel) return;

    const box = document.createElement('div');
    box.className = 'fields two';

    if (sel.kind === 'step') {
      const workflow = selectedWorkflow();
      const title = document.createElement('div');
      title.className = 'field span';
      const label = document.createElement('span');
      label.textContent = 'Editing step in ';
      const name = document.createElement('strong');
      name.textContent = workflow.name;
      title.append(label, name);
      box.appendChild(title);
      els.meta.appendChild(box);
      return;
    }

    const item = selectedPayload();
    if (!item) return;

    let slugControl;
    const nameControl = input(item.name, (v) => {
      item.name = v;
      item.slug = slugify(v, item.slug);
      if (sel.kind === 'workflow') item.id = item.slug;
      sel.slug = item.slug;
      if (slugControl) slugControl.value = item.slug;
      markDirty();
      renderSidebar();
      syncJson();
    });
    slugControl = input(item.slug, (v) => {
      item.slug = slugify(v, item.slug);
      if (sel.kind === 'workflow') item.id = item.slug;
      sel.slug = item.slug;
      markDirty();
      renderSidebar();
      syncJson();
    });
    box.appendChild(field('Name', nameControl));
    box.appendChild(field('Slug', slugControl));
    box.appendChild(field('Description', input(item.description || '', (v) => {
      item.description = v;
      markDirty();
      syncJson();
    }, { area: true }), true));

    if (sel.kind === 'workflow') {
      const check = document.createElement('label');
      check.className = 'check';
      const boxEl = document.createElement('input');
      boxEl.type = 'checkbox';
      boxEl.checked = !!item.autoApply;
      boxEl.addEventListener('change', () => {
        item.autoApply = boxEl.checked;
        markDirty();
        syncJson();
      });
      const cap = document.createElement('span');
      cap.textContent = 'Auto-apply file operations';
      check.append(boxEl, cap);
      box.appendChild(check);
    }

    els.meta.appendChild(box);
  }

  function renderStepTree() {
    const workflow = selectedWorkflow();
    els.stepTree.replaceChildren();
    if (!workflow) return;

    const walk = (steps, path, depth) => {
      steps.forEach((step, index) => {
        const here = path.concat(index);
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'step';
        row.style.paddingLeft = `${8 + depth * 16}px`;
        if (state.selection && state.selection.kind === 'step' && samePath(state.selection.path, here)) {
          row.classList.add('on');
        }
        const who = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'who';
        name.textContent = step.id;
        const kind = document.createElement('div');
        kind.className = 'kind';
        kind.textContent = step.type === 'parallel' || step.type === 'loop'
          ? step.type
          : `${step.type}${step.ref ? ` · ${step.ref}` : ''}`;
        who.append(name, kind);
        const ops = document.createElement('div');
        ops.className = 'step-ops';
        const mk = (label, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
          return b;
        };
        ops.append(
          mk('↑', () => moveStep(here, -1)),
          mk('↓', () => moveStep(here, 1)),
        );
        if (step.type === 'parallel' || step.type === 'loop') {
          ops.append(mk('+ child', () => addStep(here)));
        }
        ops.append(mk('×', () => {
          setSelection({ kind: 'step', workflowSlug: workflow.slug, path: here });
          removeSelected();
        }));
        row.append(who, ops);
        const selectStep = () => {
          setSelection({ kind: 'step', workflowSlug: workflow.slug, path: here });
        };
        row.addEventListener('click', selectStep);
        li.addEventListener('click', selectStep);
        li.appendChild(row);
        els.stepTree.appendChild(li);
        if (step.steps && step.steps.length) walk(step.steps, here, depth + 1);
      });
    };

    if (!workflow.steps.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = 'No steps yet. Add a skill, parallel group, or loop.';
      els.stepTree.appendChild(note);
      return;
    }
    walk(workflow.steps, [], 0);
  }

  function samePath(a, b) {
    return a && b && a.length === b.length && a.every((n, i) => n === b[i]);
  }

  function refsFor(type) {
    const key = ENTITY_LISTS[type];
    return (state.library[key] || []).map((item) => ({ value: item.slug, label: `${item.name} (${item.slug})` }));
  }

  function renderFields() {
    els.fields.replaceChildren();
    const sel = state.selection;
    if (!sel) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Select a workflow, step, or library entity.';
      els.fields.appendChild(p);
      return;
    }

    if (sel.kind === 'step') {
      renderStepFields();
      return;
    }
    if (sel.kind === 'workflow') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Select a step to edit it, or switch to JSON to edit the whole workflow.';
      els.fields.appendChild(p);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Delete workflow';
      del.addEventListener('click', () => {
        if (confirm('Delete this workflow?')) removeSelected();
      });
      els.fields.appendChild(del);
      return;
    }
    renderEntityFields();
  }

  function renderStepFields() {
    const workflow = selectedWorkflow();
    const step = stepAt(workflow, state.selection.path);
    if (!step) return;
    const box = document.createElement('div');
    box.className = 'fields';

    box.appendChild(field('Step id', input(step.id, (v) => {
      step.id = slugify(v, step.id);
      markDirty();
      renderStepTree();
      compileCurrent();
      syncJson();
    })));
    box.appendChild(field('Type', input(step.type, (v) => {
      step.type = v;
      if (v === 'loop' && !step.loop) step.loop = { kind: 'count', count: 1 };
      if ((v === 'loop' || v === 'parallel') && !step.steps) step.steps = [];
      markDirty();
      renderStepTree();
      compileCurrent();
      renderFields();
    }, { options: STEP_TYPES.map((t) => ({ value: t, label: t })) })));

    if (step.type !== 'parallel' && step.type !== 'loop') {
      const refs = refsFor(step.type);
      const options = [{ value: '', label: '— choose —' }, ...refs];
      if (step.ref && !refs.some((r) => r.value === step.ref)) {
        options.push({ value: step.ref, label: `${step.ref} (missing)` });
      }
      box.appendChild(field('Ref', input(step.ref || '', (v) => {
        step.ref = v;
        markDirty();
        renderStepTree();
        compileCurrent();
        syncJson();
      }, { options })));
      box.appendChild(field('Input template', input(step.input || '', (v) => {
        step.input = v;
        markDirty();
        compileCurrent();
        syncJson();
      }, { area: true, placeholder: '{{nodes.plan.output}}' }), true));
    }

    if (step.type === 'loop') {
      const loop = step.loop || (step.loop = { kind: 'count', count: 1 });
      box.appendChild(field('Loop kind', input(loop.kind, (v) => {
        loop.kind = v;
        markDirty();
        compileCurrent();
        renderFields();
      }, { options: [{ value: 'count', label: 'count' }, { value: 'until', label: 'until' }] })));
      if (loop.kind === 'count') {
        box.appendChild(field('Count', input(loop.count ?? 1, (v) => {
          loop.count = Number(v) || 1;
          markDirty();
          compileCurrent();
          syncJson();
        })));
      } else {
        box.appendChild(field('Until condition', input(loop.untilCondition || '', (v) => {
          loop.untilCondition = v;
          markDirty();
          compileCurrent();
          syncJson();
        }, { area: true })));
      }
      box.appendChild(field('Max iterations', input(loop.maxIterations ?? '', (v) => {
        loop.maxIterations = v === '' ? undefined : Number(v);
        markDirty();
        syncJson();
      })));
    }

    if (step.type === 'parallel' || step.type === 'loop') {
      box.appendChild(field('On error', input(step.onError || 'fail', (v) => {
        step.onError = v;
        markDirty();
        syncJson();
      }, { options: [{ value: 'fail', label: 'fail' }, { value: 'continue', label: 'continue' }] })));
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = 'Delete step';
    del.addEventListener('click', () => {
      if (confirm('Delete this step?')) removeSelected();
    });
    box.appendChild(del);
    els.fields.appendChild(box);
  }

  function renderEntityFields() {
    const item = selectedPayload();
    if (!item) return;
    const box = document.createElement('div');
    box.className = 'fields';
    box.appendChild(field('Body', input(item.body || '', (v) => {
      item.body = v;
      markDirty();
      syncJson();
    }, { area: true }), true));

    if (item.kind === 'skill' || item.kind === 'agent') {
      box.appendChild(field('Mode', input(item.mode || 'ask', (v) => {
        item.mode = v;
        markDirty();
        syncJson();
      }, { options: ['ask', 'agent', 'plan'].map((v) => ({ value: v, label: v })) })));
      box.appendChild(field('Model', input(item.model || '', (v) => {
        item.model = v || undefined;
        markDirty();
        syncJson();
      }, { placeholder: 'optional override' })));

      const tools = document.createElement('div');
      tools.className = 'field';
      const cap = document.createElement('span');
      cap.textContent = 'Tools';
      const row = document.createElement('div');
      row.className = 'tools';
      const current = new Set(item.tools || []);
      for (const tool of TOOLS) {
        const lab = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = current.has(tool);
        cb.addEventListener('change', () => {
          const next = new Set(item.tools || []);
          if (cb.checked) next.add(tool);
          else next.delete(tool);
          item.tools = [...next];
          markDirty();
          syncJson();
        });
        lab.append(cb, document.createTextNode(tool));
        row.appendChild(lab);
      }
      tools.append(cap, row);
      box.appendChild(tools);
    }

    if (item.kind === 'skill') {
      const activation = item.activation || (item.activation = { mode: 'on-demand' });
      box.appendChild(field('Activation', input(activation.mode, (v) => {
        activation.mode = v;
        markDirty();
        renderFields();
      }, { options: ['on-demand', 'always', 'glob'].map((v) => ({ value: v, label: v })) })));
      if (activation.mode === 'glob') {
        box.appendChild(field('Globs', input((activation.globs || []).join(', '), (v) => {
          activation.globs = v.split(',').map((s) => s.trim()).filter(Boolean);
          markDirty();
          syncJson();
        })));
      }
    }

    if (item.kind === 'instruction') {
      box.appendChild(field('Scope', input(item.scope || 'manual', (v) => {
        item.scope = v;
        markDirty();
        renderFields();
      }, { options: ['always', 'glob', 'manual'].map((v) => ({ value: v, label: v })) })));
      if (item.scope === 'glob') {
        box.appendChild(field('Globs', input((item.globs || []).join(', '), (v) => {
          item.globs = v.split(',').map((s) => s.trim()).filter(Boolean);
          markDirty();
          syncJson();
        })));
      }
    }

    if (item.kind === 'prompt') {
      const args = item.arguments || (item.arguments = []);
      const cap = document.createElement('span');
      cap.textContent = 'Arguments';
      cap.style.font = '10px/1 var(--mono)';
      cap.style.letterSpacing = '0.08em';
      cap.style.textTransform = 'uppercase';
      cap.style.color = 'var(--muted)';
      box.appendChild(cap);
      args.forEach((arg, i) => {
        const row = document.createElement('div');
        row.className = 'arg-row';
        row.append(
          input(arg.name, (v) => { arg.name = v; markDirty(); syncJson(); }, { placeholder: 'name' }),
          input(arg.description || '', (v) => { arg.description = v; markDirty(); syncJson(); }, { placeholder: 'description' }),
        );
        const req = document.createElement('label');
        req.className = 'check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!arg.required;
        cb.addEventListener('change', () => { arg.required = cb.checked; markDirty(); syncJson(); });
        req.append(cb, document.createTextNode('req'));
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '×';
        rm.addEventListener('click', () => {
          args.splice(i, 1);
          markDirty();
          renderFields();
        });
        row.append(req, rm);
        box.appendChild(row);
      });
      const addArg = document.createElement('button');
      addArg.type = 'button';
      addArg.textContent = 'Add argument';
      addArg.addEventListener('click', () => {
        args.push({ name: 'arg', required: false });
        markDirty();
        renderFields();
      });
      box.appendChild(addArg);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = `Delete ${item.kind}`;
    del.addEventListener('click', () => {
      if (confirm(`Delete ${item.slug}?`)) removeSelected();
    });
    box.appendChild(del);
    els.fields.appendChild(box);
  }

  function syncJson() {
    if (state.tab !== 'json') return;
    const payload = selectedPayload();
    els.jsonEditor.value = JSON.stringify(payload || state.library, null, 2);
  }

  function renderGraph() {
    const ir = state.compile.ir;
    els.stage.replaceChildren();
    if (state.compile.error) {
      const err = document.createElement('p');
      err.className = 'empty-note';
      err.textContent = state.compile.error;
      els.stage.appendChild(err);
      return;
    }
    if (!ir || !ir.nodes.length) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.style.padding = '16px';
      note.textContent = 'Add steps to preview the compiled graph.';
      els.stage.appendChild(note);
      return;
    }

    const W = 156, H = 62, GX = 44, GY = 42;
    const incoming = new Map(ir.nodes.map((n) => [n.id, []]));
    for (const e of ir.edges) incoming.get(e.to)?.push(e.from);
    const level = new Map();
    const visit = (id) => {
      if (level.has(id)) return level.get(id);
      const preds = incoming.get(id) || [];
      const lv = preds.length ? Math.max(...preds.map(visit)) + 1 : 0;
      level.set(id, lv);
      return lv;
    };
    ir.nodes.forEach((n) => visit(n.id));
    const rows = [];
    for (const n of ir.nodes) (rows[level.get(n.id)] ||= []).push(n);
    const widths = rows.map((row) => row.length * W + Math.max(0, row.length - 1) * GX);
    const maxW = Math.max(0, ...widths);
    const pos = new Map();
    let maxH = 0;
    rows.forEach((row, y) => {
      row.forEach((n, x) => {
        const left = (maxW - widths[y]) / 2 + x * (W + GX) + 24;
        const top = 18 + y * (H + GY);
        pos.set(n.id, { left, top, cx: left + W / 2, cy: top + H / 2 });
        maxH = Math.max(maxH, top + H + 24);
      });
    });

    const selectedStep = state.selection && state.selection.kind === 'step'
      ? stepAt(selectedWorkflow(), state.selection.path)
      : null;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'edges');
    svg.style.width = `${maxW + 48}px`;
    svg.style.height = `${maxH}px`;
    for (const e of ir.edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const mid = (a.cy + b.cy) / 2;
      path.setAttribute('d', `M ${a.cx} ${a.cy + 22} C ${a.cx} ${mid}, ${b.cx} ${mid}, ${b.cx} ${b.cy - 22}`);
      svg.appendChild(path);
    }
    els.stage.appendChild(svg);
    els.stage.style.minHeight = `${maxH}px`;

    for (const n of ir.nodes) {
      const p = pos.get(n.id);
      const el = document.createElement('div');
      el.className = 'node ' + n.kind;
      const stepId = n.kind === 'join' ? n.id.replace(/__join$/, '') : n.id;
      if (selectedStep && (selectedStep.id === stepId || selectedStep.id === n.id)) el.classList.add('on');
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = n.kind === 'join' ? 'join' : n.kind === 'loop' ? 'loop' : (n.ref || n.kind);
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = n.title || n.id;
      el.append(kind, title);
      el.addEventListener('click', () => {
        const workflow = selectedWorkflow();
        const found = findStepPath(workflow.steps, stepId);
        if (found) setSelection({ kind: 'step', workflowSlug: workflow.slug, path: found });
      });
      els.stage.appendChild(el);
    }
  }

  function findStepPath(steps, id, path = []) {
    for (let i = 0; i < (steps || []).length; i += 1) {
      const here = path.concat(i);
      if (steps[i].id === id) return here;
      const nested = findStepPath(steps[i].steps, id, here);
      if (nested) return nested;
    }
    return null;
  }

  function render() {
    if (!state.selection) {
      els.empty.hidden = false;
      els.editor.hidden = true;
    } else {
      els.empty.hidden = true;
      els.editor.hidden = false;
    }
    els.workflowBody.hidden = !(state.selection && (state.selection.kind === 'workflow' || state.selection.kind === 'step'));
    renderSidebar();
    renderMeta();
    if (!els.workflowBody.hidden) renderStepTree();
    renderFields();
    syncJson();
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('on', tab.dataset.tab === state.tab);
    });
    $('fields').hidden = state.tab !== 'fields';
    $('json-panel').hidden = state.tab !== 'json';
  }

  function exportJson() {
    const payload = selectedPayload() || state.library;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const name = state.selection ? `${state.selection.slug || 'selection'}.json` : 'library.json';
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function bind() {
    document.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => addEntity(btn.dataset.add));
    });
    $('btn-add-step').addEventListener('click', () => addStep([]));
    $('btn-save').addEventListener('click', () => saveProject().catch((err) => toast(err.message, 'fail')));
    $('btn-validate').addEventListener('click', () => {
      compileCurrent().then(() => {
        if (state.compile.error) toast(state.compile.error, 'fail');
        else toast('Workflow compiles to Graph IR', 'ok');
      });
    });
    $('btn-example').addEventListener('click', loadExample);
    $('empty-example').addEventListener('click', loadExample);
    $('btn-export').addEventListener('click', exportJson);
    $('btn-import').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        mergeExample(JSON.parse(await file.text()));
      } catch (err) {
        toast(err.message, 'fail');
      }
      e.target.value = '';
    });
    $('btn-apply-json').addEventListener('click', applyJson);
    $('btn-copy-json').addEventListener('click', async () => {
      await navigator.clipboard.writeText(els.jsonEditor.value);
      toast('Copied JSON', 'ok');
    });
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        state.tab = tab.dataset.tab;
        render();
      });
    });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveProject().catch((err) => toast(err.message, 'fail'));
      }
    });
  }

  async function loadExample() {
    try {
      mergeExample(await api('/api/example'));
    } catch (err) {
      toast(err.message, 'fail');
    }
  }

  bind();
  loadProject().catch((err) => toast(err.message, 'fail'));
})();
