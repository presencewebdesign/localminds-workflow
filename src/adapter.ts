import {
  AnyEntity,
  ProjectLibrary,
  Skill,
  SkillActivation,
} from './types';

/**
 * Map leftover agents / prompts / instructions into the Skill shape.
 * Does not write or delete files — compatibility only.
 */
export function adaptEntityToSkill(entity: AnyEntity): Skill {
  if (entity.kind === 'skill') {
    return {
      ...entity,
      mode: entity.mode || 'agent',
      activation: entity.activation || { mode: 'on-demand' },
    };
  }

  if (entity.kind === 'agent') {
    return {
      kind: 'skill',
      slug: entity.slug,
      name: entity.name,
      description: entity.description,
      brief: entity.brief,
      body: entity.body,
      mode: entity.mode,
      model: entity.model,
      tools: entity.tools,
      saveToResearch: entity.saveToResearch,
      activation: { mode: 'on-demand' },
    };
  }

  if (entity.kind === 'prompt') {
    return {
      kind: 'skill',
      slug: entity.slug,
      name: entity.name,
      description: entity.description,
      brief: entity.brief,
      body: entity.body,
      mode: 'ask',
      arguments: entity.arguments,
      activation: { mode: 'on-demand' },
    };
  }

  const activation: SkillActivation =
    entity.scope === 'always'
      ? { mode: 'always' }
      : entity.scope === 'glob'
        ? { mode: 'glob', globs: entity.globs }
        : { mode: 'on-demand' };

  return {
    kind: 'skill',
    slug: entity.slug,
    name: entity.name,
    description: entity.description,
    brief: entity.brief,
    body: entity.body,
    mode: 'ask',
    activation,
  };
}

/** Resolve a workflow step ref through skills first, then leftover entity kinds. */
export function resolveSkill(library: ProjectLibrary, ref: string): Skill | undefined {
  if (!ref) return undefined;
  const skill = library.skills.find((s) => s.slug === ref);
  if (skill) return adaptEntityToSkill(skill);
  const agent = library.agents.find((a) => a.slug === ref);
  if (agent) return adaptEntityToSkill(agent);
  const prompt = library.prompts.find((p) => p.slug === ref);
  if (prompt) return adaptEntityToSkill(prompt);
  const instruction = library.instructions.find((i) => i.slug === ref);
  if (instruction) return adaptEntityToSkill(instruction);
  return undefined;
}

/**
 * Skills whose body is injected into every applicable workflow node.
 * Always-on instructions map here. This is not ambient chat auto-invoke.
 */
export function alwaysOnSkills(library: ProjectLibrary): Skill[] {
  const fromSkills = library.skills
    .map(adaptEntityToSkill)
    .filter((s) => s.activation?.mode === 'always');
  const fromInstructions = library.instructions
    .filter((i) => i.scope === 'always')
    .map(adaptEntityToSkill);
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const skill of [...fromInstructions, ...fromSkills]) {
    if (seen.has(skill.slug)) continue;
    seen.add(skill.slug);
    out.push(skill);
  }
  return out;
}
