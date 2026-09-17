import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createDepLights } from './dep-light-store';
import { dependencyPointerRegion, DependsCard, type PointerRect } from './depends-card';

const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const rect = (left: number, top: number, right: number, bottom: number): PointerRect => ({
  left,
  top,
  right,
  bottom,
});

describe('the dependency-card pointer bridge', () => {
  // The sideways geometry the card has since 2026-09-09: the card's left edge
  // is its cell's right edge, its top is the cell's, and its lines sit inside
  // it with the card's own 6px padding around them.
  const owner = rect(10, 10, 110, 40);
  const card = rect(110, 10, 280, 90);
  const rows = [
    { id: 'w1', rect: rect(116, 16, 274, 36) },
    { id: 'w2', rect: rect(116, 56, 274, 76) },
  ];

  it('distinguishes the owner, the card’s passive space, a row target and outside', () => {
    expect(dependencyPointerRegion({ x: 50, y: 20 }, owner, rows, card)).toEqual({ kind: 'owner' });
    // Between the two lines — inside the card, on neither line.
    expect(dependencyPointerRegion({ x: 150, y: 46 }, owner, rows, card)).toEqual({
      kind: 'corridor',
    });
    expect(dependencyPointerRegion({ x: 150, y: 66 }, owner, rows, card)).toEqual({
      kind: 'row',
      id: 'w2',
    });
    expect(dependencyPointerRegion({ x: 400, y: 46 }, owner, rows, card)).toEqual({
      kind: 'outside',
    });
  });

  it('leaves the cell below the owner outside, so its own card can open', () => {
    // The point that walks down the column: 4px under the owner's bottom edge,
    // in the owner's own x range, which is the next row's Depends on cell.
    //
    // Proof: the corridor computed as the bounding box of the owner and its
    // lines — the shape this had until 2026-09-09 — and this failed on
    // `expected { kind: 'corridor' } to deeply equal { kind: 'outside' }`.
    // Watched 2026-09-09; the browser half is `e2e/hover-cards.spec.ts`'s
    // `every cell card leaves its own column clear`.
    expect(dependencyPointerRegion({ x: 50, y: 44 }, owner, rows, card)).toEqual({
      kind: 'outside',
    });
  });

  it('holds nothing but the owner and its lines before the card has a box', () => {
    // `null` is the frame between the card being asked for and being measured.
    expect(dependencyPointerRegion({ x: 150, y: 46 }, owner, rows, null)).toEqual({
      kind: 'outside',
    });
    expect(dependencyPointerRegion({ x: 50, y: 20 }, owner, rows, null)).toEqual({ kind: 'owner' });
  });

  itDom(
    'marks a finished predecessor with the status strip, and lines the others up with it',
    () => {
      render(
        <DependsCard
          number="030"
          entries={[
            { id: 'w1', number: '010', name: 'Strip', status: 'done' },
            { id: 'w2', number: '020', name: 'Sand', status: 'in_progress' },
          ]}
          depLights={createDepLights()}
          rowId="row"
          onPointEntry={() => undefined}
          onPointerOutside={() => undefined}
        />,
      );

      const targets = screen.getAllByTestId('depends-card-target');
      expect(targets).toHaveLength(2);
      const [done, going] = targets;
      // Dany, 2026-09-13: "in the dependency list mark the done items by a green
      // strip before the item". Proof: `statusStripStyle` made to answer the
      // same transparent border for every status, and this fails on `expected
      // '3px solid transparent' to be '3px solid var(--status-done)'`; watched
      // 2026-09-13.
      expect(done.getAttribute('data-status')).toBe('done');
      expect(done.style.borderLeft).toBe('3px solid var(--status-done)');
      expect(going.style.borderLeft).toBe('3px solid transparent');
      expect(going.style.paddingLeft).toBe(done.style.paddingLeft);
    },
  );

  itDom('keeps the strip where it stands when the pointer lights one line', () => {
    // Dany, 2026-09-13: "the status badge flickers when focus on tag vs when
    // focus on the cell". The lit line wore an inset box — negative margin
    // given straight back as padding — that the lines at rest did not, so the
    // 3px strip stood 4px further left the moment the pointer reached a pill
    // and jumped back when it left. The box is every line's now; only the
    // background follows the pointer.
    const depLights = createDepLights();
    render(
      <DependsCard
        number="030"
        entries={[
          { id: 'w1', number: '010', name: 'Strip', status: 'done' },
          { id: 'w2', number: '020', name: 'Sand', status: 'in_progress' },
        ]}
        depLights={depLights}
        rowId="row"
        onPointEntry={() => undefined}
        onPointerOutside={() => undefined}
      />,
    );
    const [done, going] = screen.getAllByTestId('depends-card-target');
    const boxOf = (line: HTMLElement) => ({
      margin: line.style.margin,
      padding: line.style.padding,
      paddingLeft: line.style.paddingLeft,
      borderLeft: line.style.borderLeft,
    });
    const atRest = boxOf(done);
    expect(done.style.background).toBe('');

    act(() => {
      depLights.updateHover(() => ({ rowId: 'row', pillId: 'w1' }));
    });

    expect(done.style.background).toBe('var(--card-dep-lit)');
    expect(boxOf(done)).toEqual(atRest);
    expect(boxOf(going)).toEqual({ ...atRest, borderLeft: '3px solid transparent' });
  });

  itDom('keeps the surface passive and only the unfocusable rows interactive', () => {
    render(
      <DependsCard
        number="030"
        entries={[
          { id: 'w1', number: '010', name: 'Strip', status: 'unknown' },
          { id: 'w2', number: '020', name: 'Sand', status: 'unknown' },
        ]}
        depLights={createDepLights()}
        rowId="row"
        onPointEntry={() => undefined}
        onPointerOutside={() => undefined}
      />,
    );

    expect(screen.getByRole('tooltip').style.pointerEvents).toBe('none');
    const targets = screen.getAllByTestId('depends-card-target');
    expect(targets.map((target) => target.style.pointerEvents)).toEqual(['auto', 'auto']);
    expect(targets.map((target) => target.getAttribute('tabindex'))).toEqual([null, null]);
  });

  itDom('moves owner to row, widens on return and clears outside', () => {
    const onPointEntry = vi.fn();
    const onPointerOutside = vi.fn();
    render(
      <table>
        <tbody>
          <tr>
            <td data-testid="owner">
              <DependsCard
                number="030"
                entries={[
                  { id: 'w1', number: '010', name: 'Strip', status: 'unknown' },
                  { id: 'w2', number: '020', name: 'Sand', status: 'unknown' },
                ]}
                depLights={createDepLights()}
                rowId="row"
                onPointEntry={onPointEntry}
                onPointerOutside={onPointerOutside}
              />
            </td>
          </tr>
        </tbody>
      </table>,
    );

    vi.spyOn(screen.getByTestId('owner'), 'getBoundingClientRect').mockReturnValue({
      ...owner,
      x: owner.left,
      y: owner.top,
      width: owner.right - owner.left,
      height: owner.bottom - owner.top,
      toJSON: () => ({}),
    });
    const asRect = (box: PointerRect) => ({
      ...box,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
      toJSON: () => ({}),
    });
    screen.getAllByTestId('depends-card-target').forEach((target, index) => {
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(asRect(rows[index].rect));
    });
    // The card's own box, which is what holds the pointer in the space between
    // its lines since the corridor stopped being a bounding box.
    vi.spyOn(screen.getByRole('tooltip'), 'getBoundingClientRect').mockReturnValue(asRect(card));

    const move = (clientX: number, clientY: number) => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }));
    };
    move(50, 20);
    move(150, 46);
    move(150, 66);
    move(50, 20);
    move(400, 46);

    expect(onPointEntry.mock.calls).toEqual([[null], ['w2'], [null]]);
    expect(onPointerOutside).toHaveBeenCalledTimes(1);
  });

  itDom('removes the document bridge when the card unmounts', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(
      <DependsCard
        number="030"
        entries={[{ id: 'w1', number: '010', name: 'Strip', status: 'unknown' }]}
        depLights={createDepLights()}
        rowId="row"
        onPointEntry={() => undefined}
        onPointerOutside={() => undefined}
      />,
    );

    unmount();

    expect(remove.mock.calls.some(([kind]) => kind === 'pointermove')).toBe(true);
    remove.mockRestore();
  });

  itDom('clears stale tint on pointer cancellation, scroll and resize', () => {
    const onPointerOutside = vi.fn();
    render(
      <DependsCard
        number="030"
        entries={[{ id: 'w1', number: '010', name: 'Strip', status: 'unknown' }]}
        depLights={createDepLights()}
        rowId="row"
        onPointEntry={() => undefined}
        onPointerOutside={onPointerOutside}
      />,
    );

    document.dispatchEvent(new Event('pointercancel'));
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));

    expect(onPointerOutside).toHaveBeenCalledTimes(3);
  });
});
