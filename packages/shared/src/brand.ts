/**
 * Product identity (SynergyOne brand framework). The organisation using the system (the
 * hospital) keeps its own name on payslips, letters and the careers site; PeopleTrack is
 * the product, shown with the suite endorsement.
 */
export const BRAND = {
  name: 'PeopleTrack',
  formalName: 'SynergyOne PeopleTrack — Human Resource Management System',
  suite: 'SynergyOne',
  endorsement: 'Part of the SynergyOne Suite',
  tagline: 'Empowering People. Driving Performance.',
  company: 'Synergy Informatics Limited',
  colours: {
    /** PeopleTrack accent: highlights only, never whole screens. */
    amber: '#D97706',
    navy: '#16345B',
    suiteBlue: '#0B65B9',
    background: '#F7F9FC',
  },
} as const;
