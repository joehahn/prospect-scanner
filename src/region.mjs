// WHERE A PERSON IS, AS A REGION (2026-11-24, the operator: a chart of where
// cards come from and which regions accept, "europe vs middle east vs
// US/texas/austin metro/other"). Read from the person's own location, which a
// pasted profile fills (paste-match.mjs), never from the firm's HQ: a London
// partner at a Houston firm is in London.
//
// The two home tiers come from config (icp.home_metros, icp.home_region and
// their labels), so the code says nothing about where any one operator works.
import { homeGeoOf } from './config.mjs';

// Countries and the cities LinkedIn prints without one, by region.
const MIDDLE_EAST = /\b(United Arab Emirates|UAE|Dubai|Abu Dhabi|Sharjah|Saudi Arabia|Riyadh|Jeddah|Dammam|Qatar|Doha|Kuwait|Bahrain|Manama|Oman|Muscat|Israel|Tel Aviv|Jordan|Amman|Lebanon|Beirut|Egypt|Cairo|Turkey|Türkiye|Istanbul|Iraq|Iran)\b/i;
const EUROPE = new RegExp('\\b(United Kingdom|England|Scotland|Wales|Northern Ireland|London|Manchester|Edinburgh|Ireland|Dublin'
  + '|Germany|Berlin|Munich|Frankfurt|Hamburg|France|Paris|Lyon|Netherlands|Amsterdam|Rotterdam|Belgium|Brussels|Luxembourg'
  + '|Switzerland|Zurich|Zürich|Geneva|Austria|Vienna|Italy|Milan|Rome|Spain|Madrid|Barcelona|Portugal|Lisbon'
  + '|Denmark|Copenhagen|Sweden|Stockholm|Norway|Oslo|Finland|Helsinki|Iceland|Poland|Warsaw|Czechia|Czech Republic|Prague'
  + '|Hungary|Budapest|Greece|Athens|Romania|Bucharest|Bulgaria|Croatia|Slovenia|Slovakia|Serbia|Estonia|Latvia|Lithuania'
  + '|Malta|Cyprus|Monaco|Ukraine)\\b', 'i');
const CANADA = /\b(Canada|Ontario|Quebec|Québec|British Columbia|Alberta|Manitoba|Saskatchewan|Nova Scotia|Toronto|Montreal|Montréal|Vancouver|Calgary|Ottawa|Edmonton)\b/i;
const US = new RegExp('\\b(United States|USA|Metroplex|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware'
  + '|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland'
  + '|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico'
  + '|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota'
  + '|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|Boston|Chicago|Dallas|Houston'
  + '|Atlanta|Seattle|Denver|Phoenix|Philadelphia|Detroit|Minneapolis|Miami|Charlotte|San Francisco|Los Angeles|San Diego'
  + '|Raleigh|Nashville|Pittsburgh|Cleveland|Cincinnati|Columbus|St\\.? Louis|Kansas City|Salt Lake|Portland|Baltimore'
  + '|Tampa|Orlando|Indianapolis|Milwaukee|Richmond|Sacramento|San Antonio|Austin|Silicon Valley)\\b', 'i');

// US metros LinkedIn prints without a state ("Dallas-Fort Worth Metroplex",
// "Greater Boston"), by the state's name and abbreviation, so a home region
// given as a state still catches them.
const METRO_STATE = { Dallas: 'Texas TX', 'Fort Worth': 'Texas TX', Houston: 'Texas TX', 'San Antonio': 'Texas TX',
  Austin: 'Texas TX', 'El Paso': 'Texas TX', Boston: 'Massachusetts MA', Chicago: 'Illinois IL', Atlanta: 'Georgia GA',
  Seattle: 'Washington WA', Denver: 'Colorado CO', Phoenix: 'Arizona AZ', Philadelphia: 'Pennsylvania PA',
  Pittsburgh: 'Pennsylvania PA', Detroit: 'Michigan MI', Minneapolis: 'Minnesota MN', Miami: 'Florida FL',
  Tampa: 'Florida FL', Orlando: 'Florida FL', Charlotte: 'North Carolina NC', Raleigh: 'North Carolina NC',
  'San Francisco': 'California CA', 'Los Angeles': 'California CA', 'San Diego': 'California CA',
  'Silicon Valley': 'California CA', Sacramento: 'California CA', Nashville: 'Tennessee TN', 'St. Louis': 'Missouri MO',
  'Kansas City': 'Missouri MO', 'Salt Lake': 'Utah UT', Baltimore: 'Maryland MD', Cleveland: 'Ohio OH',
  Cincinnati: 'Ohio OH', Columbus: 'Ohio OH', Indianapolis: 'Indiana IN', Milwaukee: 'Wisconsin WI',
  'New York': 'New York NY', 'Washington DC': 'District of Columbia DC' };

export const REGIONS = ['home_metro', 'home_region', 'home_country', 'canada', 'europe', 'middle_east', 'elsewhere'];

/**
 * The region of one place: a key from REGIONS, or null when there is no place
 * on file. Abroad is decided first, so a "Georgetown" or a "Paris" that is not
 * the home one cannot read as home.
 */
export function regionOf({ location, country } = {}, cfg = {}) {
  const place = [location, country].filter((x) => x && String(x).trim()).join(', ');
  if (!place) return null;
  if (MIDDLE_EAST.test(place)) return 'middle_east';
  if (EUROPE.test(place)) return 'europe';
  if (CANADA.test(place)) return 'canada';
  const home = homeGeoOf(cfg);
  const low = place.toLowerCase();
  const word = (m) => new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(place);
  const homeUs = home.geography.some((g) => ['us', 'usa', 'united states'].includes(g));
  const inHomeCountry = homeUs ? US.test(place) : home.geography.some((g) => low.includes(g));
  if (home.metros.some(word) && inHomeCountry) return 'home_metro';
  const states = Object.entries(METRO_STATE).filter(([c]) => word(c)).map(([, st]) => st).join(' ');
  if (home.region.some((m) => word(m) || new RegExp(`\\b${m}\\b`, 'i').test(states))) return 'home_region';
  if (inHomeCountry) return 'home_country';
  return 'elsewhere';
}

/** A region's label, the home tiers named by config. */
export function regionLabel(key, cfg = {}) {
  const icp = cfg.icp ?? {};
  const country = (icp.geography ?? ['US'])[0];
  return {
    home_metro: icp.home_metro_label ?? 'Home metro',
    home_region: `${icp.home_region_label ?? 'Home region'}, outside ${icp.home_metro_label ?? 'the home metro'}`,
    home_country: `Rest of ${country}`,
    canada: 'Canada', europe: 'Europe', middle_east: 'Middle East', elsewhere: 'Elsewhere',
  }[key] ?? 'No location on file';
}
