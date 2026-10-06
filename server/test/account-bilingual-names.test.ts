import { readFileSync } from 'node:fs';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Task 30B: optional bilingual account names (name_ar/name_en) with legacy `name` kept as fallback.
type Row=Record<string,unknown>;
const state=vi.hoisted(()=>({before:null as Row|null,queries:[] as Array<{sql:string;params:unknown[]}>}));
const legacy:Row={id:'11111111-1111-4111-8111-111111111111',company_id:'co-a',code:'1000',name:'Bank',name_ar:null,name_en:null,account_type:'asset',parent_account_id:null,is_active:true,statement_category:'unmapped',cash_role:'non_cash',cash_flow_category:'unmapped',is_used:true,has_children:false};
vi.mock('../src/db/pool',()=>{
 const client={query:async(sql:string,params:unknown[]=[])=>{
  state.queries.push({sql,params});
  if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return{rows:[],rowCount:0};
  if(sql.includes('FOR UPDATE OF a'))return{rows:state.before?[state.before]:[],rowCount:state.before?1:0};
  if(sql.startsWith('INSERT INTO accounts'))return{rows:[{id:'new',code:params[1],name:params[2],name_ar:params[6],name_en:params[7]}],rowCount:1};
  if(sql.startsWith('UPDATE accounts'))return{rows:[{...state.before,name:params[3],name_ar:params[7],name_en:params[8]}],rowCount:1};
  return{rows:[{is_used:true,has_children:false}],rowCount:1};
 },release:()=>{}};
 return{default:{connect:async()=>client,query:client.query}};
});
vi.mock('../src/modules/auth/auth.middleware',()=>({
 getAuthenticatedContext:()=>({user:{id:'user-1'},activeCompanyId:'co-a',capabilities:[]}),
 requireAuth:(_q:Request,_s:Response,n:NextFunction)=>n(),
 requireActiveCompany:(_q:Request,_s:Response,n:NextFunction)=>n(),
 requireCapability:()=>(_q:Request,_s:Response,n:NextFunction)=>n(),
}));
import { accountingRouter } from '../src/modules/accounting/accounting.router';

const app=express();app.use(express.json());app.use('/api',accountingRouter);
const insert=()=>state.queries.find(q=>q.sql.startsWith('INSERT INTO accounts'));
const update=()=>state.queries.find(q=>q.sql.startsWith('UPDATE accounts'));
const audit=()=>state.queries.find(q=>/INSERT INTO audit_log/i.test(q.sql));
beforeEach(()=>{state.queries=[];state.before={...legacy};});

describe('bilingual account names',()=>{
 it('migration only adds nullable localized columns and never rewrites existing names',()=>{
  const sql=readFileSync(new URL('../migrations/058_account_bilingual_names.sql',import.meta.url),'utf8').replace(/^--.*$/gm,'');
  expect(sql).toMatch(/ADD COLUMN name_ar TEXT,/);expect(sql).toMatch(/ADD COLUMN name_en TEXT;/);
  expect(sql).not.toMatch(/NOT NULL|UPDATE\s+accounts|DROP|ALTER COLUMN name\b/i);
 });
 it('creates with both localized names and derives legacy name from the Arabic name',async()=>{
  const res=await request(app).post('/api/accounts').send({code:'1100',name_ar:' النقدية ',name_en:'Cash',account_type:'asset'});
  expect(res.status).toBe(201);
  expect(insert()!.params).toEqual(['co-a','1100','النقدية','asset',null,true,'النقدية','Cash']);
  expect(JSON.stringify(audit()!.params[6])).toContain('"name_en":"Cash"');
 });
 it('derives legacy name from the localized input even if a legacy name is also sent',async()=>{
  await request(app).post('/api/accounts').send({code:'1100',name:'Other',name_en:'Cash',account_type:'asset'});
  expect(insert()!.params).toEqual(['co-a','1100','Cash','asset',null,true,null,'Cash']);
 });
 it('derives legacy name from the English name when only English is entered',async()=>{
  await request(app).post('/api/accounts').send({code:'1100',name_en:'Cash',account_type:'asset'});
  expect(insert()!.params).toEqual(['co-a','1100','Cash','asset',null,true,null,'Cash']);
 });
 it('rejects a new account without a localized name, even when legacy name is supplied',async()=>{
  expect((await request(app).post('/api/accounts').send({code:'1100',name_ar:' ',account_type:'asset'})).status).toBe(400);
  expect(insert()).toBeUndefined();
  expect((await request(app).post('/api/accounts').send({code:'1100',name:'Cash',account_type:'asset'})).status).toBe(400);
  expect((await request(app).post('/api/accounts').send({code:'1100',name:'Cash',name_ar:'',name_en:null,account_type:'asset'})).status).toBe(400);
  expect(insert()).toBeUndefined();
 });
 it('rejects over-long localized names instead of silently dropping them',async()=>{
  expect((await request(app).post('/api/accounts').send({code:'1100',name_ar:'x'.repeat(201),account_type:'asset'})).status).toBe(400);
 });
 it('adds localized names to a used legacy account without touching legacy name or locked fields',async()=>{
  const res=await request(app).patch(`/api/accounts/${legacy.id}`).send({name_ar:'البنك',name_en:'Bank'});
  expect(res.status).toBe(200);
  expect(update()!.params.slice(2)).toEqual(['1000','Bank','asset',null,true,'البنك','Bank']);
 });
 it('does not let a localized account lose both localized names',async()=>{
  state.before={...legacy,name_ar:'البنك'};
  expect((await request(app).patch(`/api/accounts/${legacy.id}`).send({name_ar:''})).status).toBe(400);
  expect(update()).toBeUndefined();
 });
 it('keeps code locks from Task 30A in force alongside localized edits',async()=>{
  expect((await request(app).patch(`/api/accounts/${legacy.id}`).send({code:'1999',name_ar:'البنك'})).status).toBe(409);
 });
});
