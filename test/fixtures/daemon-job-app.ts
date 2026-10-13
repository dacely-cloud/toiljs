@data class JobKey { id: i32 = 0; }
@data class JobRow { value: i32 = 0; constructor(value: i32 = 0) { this.value = value; } }
@database class JobDb {
  @collection static rows: Documents<JobKey, JobRow>;
  @collection static events: Events<JobKey, JobRow>;
  @collection static members: Membership<JobKey, JobKey>;
  @collection static pages: View<JobKey, JobRow>;
}
let ticks: i32 = 0;
let failNext: bool = false;
let stage: i32 = 0;
function scanAndPublish(): void {
  const key = new JobKey();
  stage = 1;
  const events = JobDb.events.latest(key, 10);
  stage = 2;
  const members = JobDb.members.list(key, 10);
  stage = 3;
  const keys = new Array<JobKey>();
  for (let i = 0; i < 65; i++) keys.push(key);
  const rows = JobDb.rows.getMany(keys);
  stage = 4;
  const page = new JobRow(events.length + members.length + rows.length);
  JobDb.pages.publish(key, page);
  stage = 5;
  ticks++;
}
@daemon class Jobs {
  onStart(): void {
    const key = new JobKey();
    JobDb.rows.upsert(key, new JobRow(7));
    JobDb.events.append(key, new JobRow(7));
    JobDb.members.add(key, key);
  }
  @scheduled("1s") @job repair(): void {
    if (failNext) { failNext = false; assert(false, "temporary job failure"); }
    scanAndPublish();
  }
  @scheduled("2s") plainScan(): void { scanAndPublish(); }
  @scheduled("2s") plainPublish(): void {
    JobDb.pages.publish(new JobKey(), new JobRow(999));
  }
  @scheduled("2s") plainWrite(): void {
    JobDb.rows.upsert(new JobKey(), new JobRow(9));
  }
}
export function readPage(): i32 {
  const page = JobDb.pages.get(new JobKey()); return page == null ? -1 : page.value;
}
export function tickCount(): i32 { return ticks; }
export function failJob(): i32 { failNext = true; return 0; }
export function jobStage(): i32 { return stage; }
