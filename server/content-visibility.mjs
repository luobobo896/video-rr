export function adultVisibilitySql(audience = 'general', alias = 'd') {
  const column = alias ? `${alias}.is_adult` : 'is_adult'
  return audience === 'adult' ? `${column} = 1` : `COALESCE(${column}, 0) = 0`
}
