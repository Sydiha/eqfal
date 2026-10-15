import i18n from '../../i18n';

/** Translation lookup in a fixed language without changing the global one. */
export const labelFor = (lng: 'ar' | 'en', key: string): string => i18n.getFixedT(lng)(key);
