import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
  const owner = rect(10, 10, 110, 40);
  const rows = [
    { id: 'w1', rect: rect(10, 48, 180, 68) },
    { id: 'w2', rect: rect(10, 68, 180, 88) },
  ];

  it('distinguishes the owner, passive corridor, row target and outside', () => {
    expect(dependencyPointerRegion({ x: 50, y: 20 }, owner, rows)).toEqual({ kind: 'owner' });
    expect(dependencyPointerRegion({ x: 50, y: 44 }, owner, rows)).toEqual({ kind: 'corridor' });
    expect(dependencyPointerRegion({ x: 50, y: 75 }, owner, rows)).toEqual({
      kind: 'row',
      id: 'w2',
    });
    expect(dependencyPointerRegion({ x: 220, y: 44 }, owner, rows)).toEqual({
      kind: 'outside',
    });
  });

  itDom('keeps the surface passive and only the unfocusable rows interactive', () => {
    render(
      <DependsCard
        number="030"
        entries={[
          { id: 'w1', number: '010', name: 'Strip' },
          { id: 'w2', number: '020', name: 'Sand' },
        ]}
        emphasisedId={null}
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
                  { id: 'w1', number: '010', name: 'Strip' },
                  { id: 'w2', number: '020', name: 'Sand' },
                ]}
                emphasisedId={null}
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
    screen.getAllByTestId('depends-card-target').forEach((target, index) => {
      const box = rows[index].rect;
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
        ...box,
        x: box.left,
        y: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
        toJSON: () => ({}),
      });
    });

    const move = (clientX: number, clientY: number) => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }));
    };
    move(50, 20);
    move(50, 44);
    move(50, 75);
    move(50, 20);
    move(220, 44);

    expect(onPointEntry.mock.calls).toEqual([[null], ['w2'], [null]]);
    expect(onPointerOutside).toHaveBeenCalledTimes(1);
  });

  itDom('removes the document bridge when the card unmounts', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(
      <DependsCard
        number="030"
        entries={[{ id: 'w1', number: '010', name: 'Strip' }]}
        emphasisedId={null}
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
        entries={[{ id: 'w1', number: '010', name: 'Strip' }]}
        emphasisedId={null}
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
