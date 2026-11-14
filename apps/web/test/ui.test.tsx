import { fireEvent, render, screen } from '@testing-library/react';
import { Dialog, ProblemBanner } from '@/components/ui';
import { ApiError } from '@/lib/api';

describe('ui', () => {
  it('shows a problem detail and its correlation reference', () => {
    render(<ProblemBanner error={new ApiError(409, { detail: 'A record with this code already exists', correlation_id: 'abcdef12-3456' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('A record with this code already exists');
    expect(screen.getByRole('alert')).toHaveTextContent('ref abcdef12');
  });

  it('maps field errors from problem details', () => {
    const e = new ApiError(422, { errors: [{ path: 'code', message: 'Too long' }] });
    expect(e.fieldErrors).toEqual({ code: 'Too long' });
  });

  it('closes the dialog on Escape and focuses its first control', () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Edit" onClose={onClose}>
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Edit');
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
