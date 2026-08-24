export const OPERATIONAL_TIME_ZONE='Asia/Riyadh';

export function operationalDate(now=new Date()):string{
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:OPERATIONAL_TIME_ZONE,
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
  }).formatToParts(now);
  const value=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)?.value;
  const year=value('year'),month=value('month'),day=value('day');
  if(!year||!month||!day)throw new Error('Could not resolve operational date');
  return `${year}-${month}-${day}`;
}
