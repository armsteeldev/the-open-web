CREATE TABLE draw_drawings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  strokes TEXT NOT NULL CHECK (length(CAST(strokes AS BLOB)) BETWEEN 2 AND 20000)
) STRICT;

CREATE INDEX draw_drawings_created_id ON draw_drawings(created_at DESC, id DESC);

CREATE TABLE draw_visitor_cooldowns (
  visitor_digest TEXT PRIMARY KEY CHECK (length(visitor_digest) = 64),
  submitted_at INTEGER NOT NULL CHECK (submitted_at >= 0)
) STRICT;

CREATE INDEX draw_visitor_cooldowns_time ON draw_visitor_cooldowns(submitted_at);

CREATE TABLE garden_plants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER NOT NULL CHECK (x BETWEEN 0 AND 17),
  y INTEGER NOT NULL CHECK (y BETWEEN 0 AND 9),
  plant_type TEXT NOT NULL CHECK (plant_type IN ('clover', 'wildflower', 'sunflower', 'grass', 'sapling')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (x, y)
) STRICT;

CREATE INDEX garden_plants_created_id ON garden_plants(created_at, id);

CREATE TABLE garden_visitor_cooldowns (
  visitor_digest TEXT PRIMARY KEY CHECK (length(visitor_digest) = 64),
  planted_at INTEGER NOT NULL CHECK (planted_at >= 0)
) STRICT;

CREATE INDEX garden_visitor_cooldowns_time ON garden_visitor_cooldowns(planted_at);

CREATE TABLE map_contributions (
  visitor_digest TEXT PRIMARY KEY CHECK (length(visitor_digest) = 64),
  country_code TEXT NOT NULL CHECK (country_code IN (
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
    'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
    'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
    'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
    'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG',
    'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN',
    'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO',
    'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI',
    'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML',
    'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC',
    'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH',
    'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA',
    'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST',
    'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR',
    'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN',
    'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
  )),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE INDEX map_contributions_country ON map_contributions(country_code);
