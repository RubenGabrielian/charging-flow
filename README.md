# ChargeFlow

Էլեկտրական մեքենաների արագ լիցքավորման վաճառքների dashboard՝ Supabase տվյալների պահպանմամբ։

## Հնարավորություններ

- Լիցքավորման տվյալների ավելացում՝ ամսաթիվ, kWh և connector type (`GB/T`, `CCS1`)
- Օրական, շաբաթական, ամսական և ընտրված ժամանակահատվածի ֆիլտրներ
- kWh-ի, մեքենաների քանակի և connector type-ի ինտերակտիվ գրաֆիկներ
- Ֆինանսական հաշվարկներ՝ 120 դրամ/kWh վաճառք, 50 դրամ/kWh ՀԷՑ վճար, 15% սպասարկում և 10% եկամտահարկ
- Վերջին լիցքավորումների էջավորում

## Vercel deploy

1. Vercel-ում ընտրեք **Add New → Project**։
2. Import արեք `RubenGabrielian/charging-flow` repository-ն։
3. Framework Preset-ը թողեք **Other**։
4. Սեղմեք **Deploy**։

`vercel.json`-ը Vercel-ին փոխանցում է, որ հրապարակվող պանակը `dist`-ն է։ Build command կամ environment variable պետք չէ։

## Supabase

Տվյալների բազայի schema-ն և RLS policy-ները գտնվում են `supabase-schema.sql` ֆայլում։ Քանի որ dashboard-ը login չունի, Supabase-ի anonymous policy-ները թույլ են տալիս կարդալ, ավելացնել և ջնջել տվյալներ։
