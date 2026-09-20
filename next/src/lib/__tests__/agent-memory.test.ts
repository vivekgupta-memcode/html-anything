import { describe, expect, it } from 'vitest';
import {
  MEMCODE_MAX_CONTEXT_BYTES,
  MEMCODE_MAX_RECORD_BYTES,
  appendConfiguredAgentMemoryPolicy,
  buildBudgetedRecallContext,
  hasExplicitMemoryWriteIntent,
} from '../agent-memory';

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;

function contentForFormattedRecordBytes(
  targetBytes: number,
  id = 'exact',
  score = 1,
): string {
  const shell = `<memory id="${id}" score="${score}">\n\n</memory>`;
  const contentBytes = targetBytes - bytes(shell);
  if (contentBytes < 1) throw new Error('target is too small for the record shell');
  return 'x'.repeat(contentBytes);
}

describe('configured agent memory policy', () => {
  it('leaves normal prompt assembly byte-for-byte unchanged while disabled', () => {
    const prompt = 'normal prompt\nwith exact whitespace\n';
    expect(
      appendConfiguredAgentMemoryPolicy(prompt, {
        enabled: false,
        explicitWriteConsent: true,
      }),
    ).toBe(prompt);
  });

  it('grants one write only for a direct remember instruction', () => {
    expect(hasExplicitMemoryWriteIntent('Remember that I prefer navy reports.')).toBe(true);
    expect(hasExplicitMemoryWriteIntent('请记住我偏好海军蓝色的季度报告。')).toBe(true);
    expect(hasExplicitMemoryWriteIntent('Create a poster that says “remember this moment”.')).toBe(false);
    expect(hasExplicitMemoryWriteIntent("Don't remember this preference.")).toBe(false);

    const ordinary = appendConfiguredAgentMemoryPolicy('prompt', {
      enabled: true,
      explicitWriteConsent: false,
    });
    expect(ordinary).toContain('does NOT authorize a memory write');
    expect(ordinary).toContain('Generation, editing, preview, export');

    const consented = appendConfiguredAgentMemoryPolicy('prompt', {
      enabled: true,
      explicitWriteConsent: true,
    });
    expect(consented).toContain('ONE save_memory call');
    expect(consented).toContain('Do not retry the write');
  });
});

describe('recall budget reference implementation', () => {
  it('sorts score descending, stable id ascending, and invalid scores last', () => {
    const result = buildBudgetedRecallContext([
      { id: 'z', score: 0.8, content: 'third' },
      { id: 'b', score: 0.9, content: 'second' },
      { id: 'a', score: 0.9, content: 'first' },
      { id: 'missing', score: Number.NaN, content: 'last' },
    ]);
    expect(result).not.toBeNull();
    const block = result!.block;
    expect(block.indexOf('id="a"')).toBeLessThan(block.indexOf('id="b"'));
    expect(block.indexOf('id="b"')).toBeLessThan(block.indexOf('id="z"'));
    expect(block.indexOf('id="z"')).toBeLessThan(block.indexOf('id="missing"'));
  });

  it('accepts an individual record exactly at 2,048 bytes', () => {
    const content = contentForFormattedRecordBytes(MEMCODE_MAX_RECORD_BYTES);
    const result = buildBudgetedRecallContext([
      { id: 'exact', score: 1, content },
    ]);
    expect(result?.included).toBe(1);
    expect(bytes(result!.block)).toBeLessThanOrEqual(MEMCODE_MAX_CONTEXT_BYTES);
  });

  it('drops the whole recall block when the first record is 2,049 bytes', () => {
    const content = contentForFormattedRecordBytes(MEMCODE_MAX_RECORD_BYTES + 1);
    expect(
      buildBudgetedRecallContext([{ id: 'exact', score: 1, content }]),
    ).toBeNull();
  });

  it('keeps complete records below 8,192 bytes and reports the remainder', () => {
    const records = Array.from({ length: 4 }, (_, index) => {
      const id = `r${index}`;
      return {
        id,
        score: 4 - index,
        content: contentForFormattedRecordBytes(
          MEMCODE_MAX_RECORD_BYTES,
          id,
          4 - index,
        ),
      };
    });
    const result = buildBudgetedRecallContext(records);
    expect(result).not.toBeNull();
    expect(result!.included).toBe(3);
    expect(result!.omitted).toBe(1);
    expect(result!.block).toContain('<omitted count="1" />');
    expect(bytes(result!.block)).toBeLessThanOrEqual(MEMCODE_MAX_CONTEXT_BYTES);
  });

  it('requests no more than five deterministic records from a fake transcript', () => {
    const transcript = Array.from({ length: 6 }, (_, index) => ({
      id: `memory-${index}`,
      score: 1 - index / 10,
      content: `preference ${index}`,
    }));
    const result = buildBudgetedRecallContext(transcript);
    expect(result).toMatchObject({ included: 5, omitted: 1 });
    expect(result!.block).not.toContain('id="memory-5"');
  });

  it('fails open without memory for unavailable or malformed transcripts', () => {
    expect(buildBudgetedRecallContext(null)).toBeNull();
    expect(buildBudgetedRecallContext([{ score: 1, content: 'no stable id' }])).toBeNull();
  });
});
