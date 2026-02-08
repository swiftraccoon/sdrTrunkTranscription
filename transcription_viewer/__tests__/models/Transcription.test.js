/* eslint-disable global-require */
jest.mock('mongoose', () => {
  const models = {};
  // Must be a regular function so it works with `new`
  function MockSchema() {
    this.index = jest.fn();
    this.pre = jest.fn();
    this.post = jest.fn();
    this.statics = {};
  }

  return {
    Schema: MockSchema,
    model(name, s) {
      if (s) {
        const m = { init: jest.fn().mockResolvedValue() };
        Object.assign(m, s.statics);
        models[name] = m;
        return m;
      }
      return models[name];
    },
  };
});

const Transcription = require('../../models/Transcription');

describe('Transcription.filterTranscriptions', () => {
  const filter = Transcription.filterTranscriptions.bind(Transcription);

  test('passes through normal transcription text', () => {
    const input = [
      { text: 'All units respond to main street' },
      { text: 'Copy that, en route' },
    ];
    expect(filter(input)).toHaveLength(2);
  });

  test('filters "thank you" variations', () => {
    const input = [
      { text: 'Thank you' },
      { text: 'thank you!' },
      { text: 'Thank you.' },
      { text: 'THANK YOU' },
    ];
    expect(filter(input)).toHaveLength(0);
  });

  test('does not filter "thank you" inside longer text', () => {
    const input = [{ text: 'Thank you for responding' }];
    expect(filter(input)).toHaveLength(1);
  });

  test('filters BANG variations', () => {
    const input = [
      { text: 'BANG' },
      { text: 'BANG BANG' },
      { text: 'BANG! BANG!' },
      { text: 'bang' },
    ];
    expect(filter(input)).toHaveLength(0);
  });

  test('filters AH/AHH variations', () => {
    const input = [
      { text: 'AH' },
      { text: 'AHH' },
      { text: 'AHHHHHH' },
      { text: 'ah' },
      { text: 'ahh' },
    ];
    expect(filter(input)).toHaveLength(0);
  });

  test('filters dots-only text', () => {
    const input = [
      { text: '.' },
      { text: '...' },
      { text: '. . .' },
      { text: '.. ..' },
    ];
    expect(filter(input)).toHaveLength(0);
  });

  test('handles empty array', () => {
    expect(filter([])).toHaveLength(0);
  });

  test('handles mixed valid and invalid transcriptions', () => {
    const input = [
      { text: 'Unit 5 responding' },
      { text: 'BANG BANG' },
      { text: '10-4 copy' },
      { text: '...' },
      { text: 'Thank you' },
    ];
    const result = filter(input);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Unit 5 responding');
    expect(result[1].text).toBe('10-4 copy');
  });
});
