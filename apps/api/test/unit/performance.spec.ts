import { ratingBand } from '@sil/hr-shared';
import { weightedRating } from '../../src/modules/performance/performance.service';

describe('appraisal ratings', () => {
  it('weights goal scores by their weight', () => {
    expect(weightedRating([{ weight: 60, score: 4 }, { weight: 30, score: 5 }, { weight: 10, score: 3 }])).toBe('4.20');
    expect(weightedRating([{ weight: 50, score: 3 }, { weight: 50, score: 4 }])).toBe('3.50');
    expect(weightedRating([{ weight: 70, score: 2 }, { weight: 30, score: 3 }])).toBe('2.30');
  });
  it('is undecided while any goal is unscored, or with no goals', () => {
    expect(weightedRating([{ weight: 60, score: 4 }, { weight: 40, score: null }])).toBeNull();
    expect(weightedRating([])).toBeNull();
  });
  it('maps ratings to bands at the boundaries', () => {
    expect(ratingBand('4.50')).toBe('Outstanding');
    expect(ratingBand('4.49')).toBe('Exceeds expectations');
    expect(ratingBand('3.50')).toBe('Exceeds expectations');
    expect(ratingBand('2.50')).toBe('Meets expectations');
    expect(ratingBand('2.49')).toBe('Below expectations');
    expect(ratingBand('1.00')).toBe('Unsatisfactory');
    expect(ratingBand(null)).toBeNull();
  });
});
