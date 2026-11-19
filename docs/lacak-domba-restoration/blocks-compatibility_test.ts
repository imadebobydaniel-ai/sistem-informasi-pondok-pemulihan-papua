import { assert, assertEquals } from 'jsr:@std/assert@1';
import postgres from 'npm:postgres@3.4.5';
const url=Deno.env.get('LD_TEST_DB_URL')||'';
if(!/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/postgres$/.test(url))throw Error('New local synthetic database required');
const open=()=>postgres(url,{max:1,onnotice:()=>{}}),owner='test-ld-block-protocol';
const replace=(sql:ReturnType<typeof open>,uid:string,peers:string[])=>sql`select public.lacak_domba_replace_own_blocks(${uid},${peers}::text[]) as n`;
Deno.test('nonempty block list has no identifier ambiguity and preserves attempted-count semantics',async()=>{
 const sql=open();try{await sql`delete from public.lacak_domba_blocks where blocker_uid=${owner}`;
 const [r]=await replace(sql,owner,['test-peer','test-peer',owner]);assertEquals(r.n,2);
 assertEquals((await sql`select blocked_uid from public.lacak_domba_blocks where blocker_uid=${owner}`).map(r=>r.blocked_uid),['test-peer']);
 }finally{await sql`delete from public.lacak_domba_blocks where blocker_uid=${owner}`;await sql.end();}
});
Deno.test('concurrent replacements serialize per owner and never merge two block lists',async()=>{
 const a=open(),b=open(),observer=open();let transaction=false;
 try{await a`delete from public.lacak_domba_blocks where blocker_uid=${owner}`;
 const [{pid}]=await b`select pg_backend_pid() as pid`;await a.unsafe('begin');transaction=true;
 await replace(a,owner,['test-a1','test-a2']);const pending=replace(b,owner,['test-b-only']).then(r=>r);
 let locked=false;for(let i=0;i<100;i++){const [state]=await observer`select wait_event_type from pg_stat_activity where pid=${pid}`;if(state?.wait_event_type==='Lock'){locked=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert(locked,'Replacement B must actually wait for A');await a.unsafe('commit');transaction=false;await pending;
 assertEquals((await observer`select blocked_uid from public.lacak_domba_blocks where blocker_uid=${owner} order by blocked_uid`).map(r=>r.blocked_uid),['test-b-only']);
 }finally{if(transaction)await a.unsafe('rollback');await observer`delete from public.lacak_domba_blocks where blocker_uid=${owner}`;await Promise.all([a.end(),b.end(),observer.end()]);}
});
Deno.test('different owners remain independent and one owner cannot erase the other block mirror',async()=>{
 const a=open(),b=open();let transaction=false;
 try{await a.unsafe('begin');transaction=true;await replace(a,owner,['test-preserved']);
 await replace(b,'test-ld-other-block-owner',['test-other']);await a.unsafe('commit');transaction=false;
 assertEquals((await b`select blocked_uid from public.lacak_domba_blocks where blocker_uid=${owner}`).map(r=>r.blocked_uid),['test-preserved']);
 }finally{if(transaction)await a.unsafe('rollback');await b`delete from public.lacak_domba_blocks where blocker_uid in (${owner},'test-ld-other-block-owner')`;await Promise.all([a.end(),b.end()]);}
});
