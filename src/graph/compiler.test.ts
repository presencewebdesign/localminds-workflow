import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow } from './compiler';
import { Workflow } from '../types';

describe('compileWorkflow', () => {
  it('chains sequential skill nodes', () => {
    const wf: Workflow = {
      id: 't',
      slug: 't',
      name: 't',
      steps: [
        { id: 'a', type: 'skill', ref: 'one' },
        { id: 'b', type: 'skill', ref: 'two' },
      ],
    };
    const ir = compileWorkflow(wf);
    assert.equal(ir.nodes.length, 2);
    assert.deepEqual(ir.edges, [{ from: 'a', to: 'b' }]);
  });

  it('generates a join for a parallel group', () => {
    const wf: Workflow = {
      id: 't',
      slug: 't',
      name: 't',
      steps: [
        { id: 'plan', type: 'skill', ref: 'plan' },
        {
          id: 'fanout',
          type: 'parallel',
          steps: [
            { id: 'web', type: 'skill', ref: 'web' },
            { id: 'repo', type: 'skill', ref: 'repo' },
          ],
        },
        { id: 'review', type: 'skill', ref: 'review' },
      ],
    };
    const ir = compileWorkflow(wf);
    const join = ir.nodes.find((n) => n.kind === 'join');
    assert.ok(join);
    assert.equal(join?.id, 'fanout__join');
    assert.ok(ir.edges.some((e) => e.from === 'plan' && e.to === 'web'));
    assert.ok(ir.edges.some((e) => e.from === 'plan' && e.to === 'repo'));
    assert.ok(ir.edges.some((e) => e.from === 'web' && e.to === 'fanout__join'));
    assert.ok(ir.edges.some((e) => e.from === 'repo' && e.to === 'fanout__join'));
    assert.ok(ir.edges.some((e) => e.from === 'fanout__join' && e.to === 'review'));
  });
});
