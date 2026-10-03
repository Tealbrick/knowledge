import { describe, expect, test } from 'bun:test';
import { FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE, renderFactsTable, stripFactsFence, type ParsedFact } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE, stripTakesFence } from '../src/core/takes-fence.ts';
import { chunkText } from '../src/core/chunkers/recursive.ts';
const row = (claim: string, visibility: 'world' | 'private'): ParsedFact => ({ rowNum:1, claim, visibility, kind:'fact', confidence:1, notability:'medium', validFrom:'2026-01-01', active:true });
const fence = (claim: string, visibility: 'world' | 'private') => renderFactsTable([row(claim, visibility)]);
const sanitize = (body: string) => stripFactsFence(stripTakesFence(body), { keepVisibility:['world'] });
describe('all-region private fence boundary', () => {
  test('repeated facts and takes retain public facts and ordinary prose only', () => {
    const input = ['# Header', fence('PRIVATE_FIRST','private'), 'ordinary prose', fence('PUBLIC_ONE','world'), `${TB}TAKE_FIRST${TE}`, fence('PRIVATE_SECOND','private'), `${TB}TAKE_SECOND${TE}`, fence('PUBLIC_TWO','world'), '## Notes\nvisible tail'].join('\n');
    const output=sanitize(input);
    for(const marker of ['PRIVATE_FIRST','PRIVATE_SECOND','TAKE_FIRST','TAKE_SECOND']) expect(output).not.toContain(marker);
    for(const marker of ['# Header','ordinary prose','PUBLIC_ONE','PUBLIC_TWO','## Notes\nvisible tail']) expect(output).toContain(marker);
    const chunks=chunkText(input).map(c=>c.text).join('\n');
    expect(chunks).toContain('PUBLIC_ONE'); expect(chunks).toContain('PUBLIC_TWO');
    expect(chunks).not.toContain('PRIVATE_'); expect(chunks).not.toContain('TAKE_');
    expect(stripFactsFence(fence('ONE','world')+fence('TWO','world'))).toBe('');
  });
  test('unclosed and nested regions fail closed without dropping surrounding prose', () => {
    expect(sanitize('before'+FB+'PRIVATE_UNCLOSED')).toBe('before');
    expect(sanitize('before'+TB+'TAKE_UNCLOSED')).toBe('before');
    expect(sanitize('before'+FB+FB+'INNER_PRIVATE'+FE+'OUTER_PRIVATE'+FE+'after')).toBe('beforeafter');
    expect(sanitize('before'+TB+TB+'INNER_TAKE'+TE+'OUTER_TAKE'+TE+'after')).toBe('beforeafter');
    expect(sanitize('before'+TB+FB+TE+'CROSSED_PRIVATE'+FE+'after')).toBe('beforeafter');
    expect(sanitize('before'+FB+TB+FE+'CROSSED_TAKE'+TE+'after')).toBe('beforeafter');
    expect(sanitize('ordinary # Facts heading without markers')).toBe('ordinary # Facts heading without markers');
  });
  test('many regions and nested malformed markers are processed without leaked tails', () => {
    expect(stripTakesFence((TB+'secret'+TE).repeat(5000))).toBe('');
    expect(stripFactsFence(FB.repeat(5000)+'secret'+FE.repeat(5000), {keepVisibility:['world']})).toBe('');
  });
});
