'use server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getActor } from '@/lib/authz'
const COMPANY_ID='00000000-0000-0000-0000-000000000001'
export async function getCrmFields(){const a=await getActor();if(!a||a.role!=='owner')return [];const {data}=await (await createClient()).from('crm_custom_fields').select('*').eq('company_id',COMPANY_ID).order('entity').order('sort_order');return data??[]}
export async function createCrmField(f:FormData){const a=await getActor();if(!a||a.role!=='owner')throw new Error('Недостаточно прав');const key=String(f.get('key')??'').trim().toLowerCase().replace(/[^a-z0-9_]+/g,'_'),label=String(f.get('label')??'').trim(),entity=String(f.get('entity')??'client');if(!key||!label||!['client','deal'].includes(entity))throw new Error('Заполните название и ключ поля');const {error}=await (await createClient()).from('crm_custom_fields').insert({company_id:COMPANY_ID,entity,key,label,field_type:String(f.get('field_type')??'text')});if(error)throw new Error(error.code==='23505'?'Такое поле уже существует':'Не удалось создать поле');revalidatePath('/dashboard/settings/crm-fields')}
export async function deleteCrmField(id:string){const a=await getActor();if(!a||a.role!=='owner')throw new Error('Недостаточно прав');await (await createClient()).from('crm_custom_fields').delete().eq('id',id).eq('company_id',COMPANY_ID);revalidatePath('/dashboard/settings/crm-fields')}
