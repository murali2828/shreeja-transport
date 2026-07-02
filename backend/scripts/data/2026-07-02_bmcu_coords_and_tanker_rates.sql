-- 2026-07-02_bmcu_coords_and_tanker_rates.sql
-- Source: "Longitude__Latitude_Latest_02.07.26.xlsx" (BMCU coordinates, incl. closed BMCUs)
-- 1) Sets latitude/longitude on bmcus matched by bmcu_code (173 plants).
-- 2) Sets rate_per_km_bmcu on tankers with no rate at all to the fleet's average effective rate.
-- Idempotent — safe to re-run. Apply to QA first; to production after UAT.
BEGIN;

UPDATE bmcus SET latitude=13.37264817, longitude=79.19658454, updated_at=NOW() WHERE bmcu_code='3001'; -- PENUMURU
UPDATE bmcus SET latitude=13.45157256, longitude=79.10084679, updated_at=NOW() WHERE bmcu_code='3002'; -- PAKALA
UPDATE bmcus SET latitude=13.479795522, longitude=79.047013329, updated_at=NOW() WHERE bmcu_code='3003'; -- DAMALACHERUVU
UPDATE bmcus SET latitude=13.3436598, longitude=79.0115167, updated_at=NOW() WHERE bmcu_code='3004'; -- Y S GATE
UPDATE bmcus SET latitude=13.532825273, longitude=79.084886396, updated_at=NOW() WHERE bmcu_code='3005'; -- KOMIREDDYGARI PALLI
UPDATE bmcus SET latitude=13.41766182, longitude=79.16709623, updated_at=NOW() WHERE bmcu_code='3006'; -- POLIREDDIPALLI
UPDATE bmcus SET latitude=13.430112974, longitude=79.015742792, updated_at=NOW() WHERE bmcu_code='3007'; -- POLAKALA
UPDATE bmcus SET latitude=13.69497555, longitude=79.59429045, updated_at=NOW() WHERE bmcu_code='3010'; -- YERPEDU
UPDATE bmcus SET latitude=13.601205878, longitude=79.931584208, updated_at=NOW() WHERE bmcu_code='3011'; -- VARADAIAHPALEM
UPDATE bmcus SET latitude=13.83247581, longitude=79.58438491, updated_at=NOW() WHERE bmcu_code='3012'; -- PALLAMPET
UPDATE bmcus SET latitude=13.699569541, longitude=79.8516952, updated_at=NOW() WHERE bmcu_code='3013'; -- B N KHANDRIGA
UPDATE bmcus SET latitude=13.75086003, longitude=79.71379408, updated_at=NOW() WHERE bmcu_code='3014'; -- THOTTAMBEDU
UPDATE bmcus SET latitude=13.620416667, longitude=79.428355, updated_at=NOW() WHERE bmcu_code='3015'; -- PICHATUR
UPDATE bmcus SET latitude=13.387231667, longitude=79.794563333, updated_at=NOW() WHERE bmcu_code='3016'; -- NAGALAPURAM
UPDATE bmcus SET latitude=13.529088333, longitude=79.73723, updated_at=NOW() WHERE bmcu_code='3017'; -- K V B PURAM
UPDATE bmcus SET latitude=13.435296667, longitude=79.950756667, updated_at=NOW() WHERE bmcu_code='3018'; -- SATYAVEDU
UPDATE bmcus SET latitude=13.317364, longitude=79.711415, updated_at=NOW() WHERE bmcu_code='3019'; -- PANNURU
UPDATE bmcus SET latitude=13.47442894, longitude=79.54004515, updated_at=NOW() WHERE bmcu_code='3020'; -- PUTTURU CC
UPDATE bmcus SET latitude=13.55696092, longitude=79.30325492, updated_at=NOW() WHERE bmcu_code='3021'; -- CHANDRAGIRI CC
UPDATE bmcus SET latitude=13.4407175146043, longitude=79.3150129448622, updated_at=NOW() WHERE bmcu_code='3022'; -- Vedurukuppam
UPDATE bmcus SET latitude=13.3625, longitude=79.08556, updated_at=NOW() WHERE bmcu_code='3023'; -- Rangampeta Cross
UPDATE bmcus SET latitude=12.628154, longitude=79.891465, updated_at=NOW() WHERE bmcu_code='3101'; -- Kumaravadi
UPDATE bmcus SET latitude=12.764862, longitude=79.81339, updated_at=NOW() WHERE bmcu_code='3102'; -- Thamanuru
UPDATE bmcus SET latitude=12.172576, longitude=79.154298, updated_at=NOW() WHERE bmcu_code='3103'; -- Konaluru
UPDATE bmcus SET latitude=12.398364, longitude=78.965099, updated_at=NOW() WHERE bmcu_code='3104'; -- Karapattu
UPDATE bmcus SET latitude=12.106328, longitude=79.023715, updated_at=NOW() WHERE bmcu_code='3105'; -- Vanapuram
UPDATE bmcus SET latitude=12.471861, longitude=79.600549, updated_at=NOW() WHERE bmcu_code='3106'; -- Vandavasi
UPDATE bmcus SET latitude=12.264429, longitude=79.565819, updated_at=NOW() WHERE bmcu_code='3107'; -- Devanur
UPDATE bmcus SET latitude=12.62742, longitude=77.84306, updated_at=NOW() WHERE bmcu_code='3108'; -- SANKARANARAYANAPURAM
UPDATE bmcus SET latitude=12.504582, longitude=79.192943, updated_at=NOW() WHERE bmcu_code='3109'; -- Mandakulathur
UPDATE bmcus SET latitude=12.376093, longitude=78.40722, updated_at=NOW() WHERE bmcu_code='3110'; -- Kankanur
UPDATE bmcus SET latitude=12.29147, longitude=78.495116, updated_at=NOW() WHERE bmcu_code='3112'; -- Harur
UPDATE bmcus SET latitude=12.590712, longitude=77.705441, updated_at=NOW() WHERE bmcu_code='3113'; -- CR Palyam
UPDATE bmcus SET latitude=12.381132, longitude=79.97207, updated_at=NOW() WHERE bmcu_code='3116'; -- LN Puram
UPDATE bmcus SET latitude=12.9275, longitude=70.14108, updated_at=NOW() WHERE bmcu_code='3117'; -- Avalurpet
UPDATE bmcus SET latitude=12.197161, longitude=78.352447, updated_at=NOW() WHERE bmcu_code='3119'; -- K Eachampadi
UPDATE bmcus SET latitude=11.899335, longitude=78.38432, updated_at=NOW() WHERE bmcu_code='3123'; -- ALELUPURAM
UPDATE bmcus SET latitude=13.788155162, longitude=78.986930227, updated_at=NOW() WHERE bmcu_code='3201'; -- MELLACHERUV
UPDATE bmcus SET latitude=13.710465634, longitude=79.131168717, updated_at=NOW() WHERE bmcu_code='3202'; -- Y V PALLM
UPDATE bmcus SET latitude=14.24186, longitude=78.25658, updated_at=NOW() WHERE bmcu_code='3203'; -- TALAPULA(PILER
UPDATE bmcus SET latitude=13.651825225, longitude=79.154660748, updated_at=NOW() WHERE bmcu_code='3204'; -- BAKARAPETA
UPDATE bmcus SET latitude=13.65117833, longitude=79.087582625, updated_at=NOW() WHERE bmcu_code='3205'; -- C.G.GALLU
UPDATE bmcus SET latitude=13.790025081, longitude=79.102743885, updated_at=NOW() WHERE bmcu_code='3206'; -- BODEVANDLAPALLI
UPDATE bmcus SET latitude=13.42276376, longitude=79.44751361, updated_at=NOW() WHERE bmcu_code='3207'; -- KARVETINAGARAM
UPDATE bmcus SET latitude=13.30649593, longitude=79.32925448, updated_at=NOW() WHERE bmcu_code='3208'; -- S R PURAM
UPDATE bmcus SET latitude=13.29432551, longitude=79.25619257, updated_at=NOW() WHERE bmcu_code='3209'; -- KOTHAPALLIMITTA
UPDATE bmcus SET latitude=13.3410931, longitude=79.42288151, updated_at=NOW() WHERE bmcu_code='3210'; -- KOLLAGUNTA
UPDATE bmcus SET latitude=13.38139554, longitude=79.277635, updated_at=NOW() WHERE bmcu_code='3211'; -- KONDAKINDA PALI
UPDATE bmcus SET latitude=13.32502302, longitude=79.60278801, updated_at=NOW() WHERE bmcu_code='3212'; -- M.KOTHURU
UPDATE bmcus SET latitude=13.412021, longitude=79.640516, updated_at=NOW() WHERE bmcu_code='3213'; -- NARAYANAVANAM
UPDATE bmcus SET latitude=13.313614, longitude=79.588514, updated_at=NOW() WHERE bmcu_code='3214'; -- KEELAPATTU
UPDATE bmcus SET latitude=13.16121447, longitude=79.03915346, updated_at=NOW() WHERE bmcu_code='3215'; -- YADAMARI
UPDATE bmcus SET latitude=13.265676, longitude=79.05941023, updated_at=NOW() WHERE bmcu_code='3217'; -- K PATNAM
UPDATE bmcus SET latitude=13.3185975, longitude=79.02987651, updated_at=NOW() WHERE bmcu_code='3218'; -- MADDIPATLAPALLI
UPDATE bmcus SET latitude=13.18474805, longitude=79.09614512, updated_at=NOW() WHERE bmcu_code='3219'; -- REDDIGUNTA
UPDATE bmcus SET latitude=13.08776705, longitude=79.05983361, updated_at=NOW() WHERE bmcu_code='3220'; -- THUMINDAPALLYAM
UPDATE bmcus SET latitude=13.05611372, longitude=79.159117341, updated_at=NOW() WHERE bmcu_code='3221'; -- BOMMA SAMUDRAM
UPDATE bmcus SET latitude=13.23211148, longitude=79.18079859, updated_at=NOW() WHERE bmcu_code='3222'; -- G D NELLORE
UPDATE bmcus SET latitude=13.19277977, longitude=79.26884765, updated_at=NOW() WHERE bmcu_code='3223'; -- THUGUNDRAM
UPDATE bmcus SET latitude=13.20935528, longitude=79.39258957, updated_at=NOW() WHERE bmcu_code='3224'; -- PALASAMUDRAM
UPDATE bmcus SET latitude=13.17539543, longitude=79.20973816, updated_at=NOW() WHERE bmcu_code='3225'; -- B N R PETA
UPDATE bmcus SET latitude=13.096087, longitude=78.981808, updated_at=NOW() WHERE bmcu_code='3226'; -- PATRAPALLI
UPDATE bmcus SET latitude=13.872897, longitude=79.003026, updated_at=NOW() WHERE bmcu_code='3227'; -- PINCHA
UPDATE bmcus SET latitude=13.73609, longitude=79.10667, updated_at=NOW() WHERE bmcu_code='3228'; -- Udaymanikyam CC
UPDATE bmcus SET latitude=13.218317628, longitude=78.732796311, updated_at=NOW() WHERE bmcu_code='3401'; -- GANGAVARAM
UPDATE bmcus SET latitude=13.092493, longitude=78.614841, updated_at=NOW() WHERE bmcu_code='3402'; -- BAIREDDIPALLE
UPDATE bmcus SET latitude=13.190674782, longitude=78.744994998, updated_at=NOW() WHERE bmcu_code='3403'; -- PALAMANER
UPDATE bmcus SET latitude=13.290421798, longitude=78.684740354, updated_at=NOW() WHERE bmcu_code='3404'; -- PEDDAPANJANI
UPDATE bmcus SET latitude=13.183069, longitude=78.634939, updated_at=NOW() WHERE bmcu_code='3405'; -- PATHIKONDA
UPDATE bmcus SET latitude=13.20423378, longitude=78.76838603, updated_at=NOW() WHERE bmcu_code='3406'; -- PALAMANER CC
UPDATE bmcus SET latitude=13.001935958, longitude=78.478612683, updated_at=NOW() WHERE bmcu_code='3407'; -- V KOTA
UPDATE bmcus SET latitude=12.895451002, longitude=78.48314157, updated_at=NOW() WHERE bmcu_code='3408'; -- RAMAKUPPAM
UPDATE bmcus SET latitude=12.857892623, longitude=78.39622879, updated_at=NOW() WHERE bmcu_code='3409'; -- SHANTHI PURAM
UPDATE bmcus SET latitude=12.808010643, longitude=78.565593353, updated_at=NOW() WHERE bmcu_code='3413'; -- PEDDURU BMCU
UPDATE bmcus SET latitude=12.798230052, longitude=78.277657628, updated_at=NOW() WHERE bmcu_code='3414'; -- GUDUPALLI
UPDATE bmcus SET latitude=12.749997363, longitude=78.344029654, updated_at=NOW() WHERE bmcu_code='3415'; -- KUPPAM
UPDATE bmcus SET latitude=12.838712, longitude=78.378135, updated_at=NOW() WHERE bmcu_code='3416'; -- 7th Mile CC
UPDATE bmcus SET latitude=12.681387, longitude=78.399506, updated_at=NOW() WHERE bmcu_code='3417'; -- Avulanatham CC
UPDATE bmcus SET latitude=12.70476987, longitude=78.341905953, updated_at=NOW() WHERE bmcu_code='3418'; -- NADIMUR
UPDATE bmcus SET latitude=13.36813963, longitude=78.56926611, updated_at=NOW() WHERE bmcu_code='3419'; -- PUNGANUR
UPDATE bmcus SET latitude=13.5003198, longitude=78.56163226, updated_at=NOW() WHERE bmcu_code='3420'; -- CHANDRAMAKULA PALLI
UPDATE bmcus SET latitude=13.32974981, longitude=78.72693432, updated_at=NOW() WHERE bmcu_code='3421'; -- RAYALAPETA
UPDATE bmcus SET latitude=13.200439406, longitude=78.913877479, updated_at=NOW() WHERE bmcu_code='3422'; -- BANGARUPALYAM
UPDATE bmcus SET latitude=13.126012109, longitude=79.013876086, updated_at=NOW() WHERE bmcu_code='3424'; -- KASIRALA
UPDATE bmcus SET latitude=13.298205506, longitude=78.939834785, updated_at=NOW() WHERE bmcu_code='3425'; -- GAJULAPALLI
UPDATE bmcus SET latitude=13.258123675, longitude=78.896512637, updated_at=NOW() WHERE bmcu_code='3426'; -- THUMBA KUPPM
UPDATE bmcus SET latitude=13.253629483, longitude=78.893378729, updated_at=NOW() WHERE bmcu_code='3427'; -- PERUMALA PALLI
UPDATE bmcus SET latitude=13.19712387, longitude=78.99861468, updated_at=NOW() WHERE bmcu_code='3429'; -- G.K.MANCHI
UPDATE bmcus SET latitude=13.18652609, longitude=78.84255014, updated_at=NOW() WHERE bmcu_code='3430'; -- MOGILI
UPDATE bmcus SET latitude=12.839250927, longitude=78.373415865, updated_at=NOW() WHERE bmcu_code='3431'; -- SANTHIPURAM CC
UPDATE bmcus SET latitude=13.04442, longitude=78.861219, updated_at=NOW() WHERE bmcu_code='3432'; -- MADETIPALLI
UPDATE bmcus SET latitude=12.714486, longitude=78.342714, updated_at=NOW() WHERE bmcu_code='3433'; -- MALLANUR KOTTALAU
UPDATE bmcus SET latitude=13.19659, longitude=78.461186, updated_at=NOW() WHERE bmcu_code='3434'; -- N VADDANAHALLI
UPDATE bmcus SET latitude=12.783616, longitude=78.360162, updated_at=NOW() WHERE bmcu_code='3435'; -- Settipalli
UPDATE bmcus SET latitude=13.008226, longitude=78.473293, updated_at=NOW() WHERE bmcu_code='3436'; -- VK Patrapalli CC
UPDATE bmcus SET latitude=12.83225, longitude=78.506344, updated_at=NOW() WHERE bmcu_code='3437'; -- Kuppiganipalli
UPDATE bmcus SET latitude=12.759316, longitude=78.393464, updated_at=NOW() WHERE bmcu_code='3438'; -- KUPPAM RURAL CC
UPDATE bmcus SET latitude=13.1974434, longitude=78.9924658, updated_at=NOW() WHERE bmcu_code='3439'; -- KG Sathram
UPDATE bmcus SET latitude=13.02568, longitude=78.36489, updated_at=NOW() WHERE bmcu_code='3440'; -- Kondahalli
UPDATE bmcus SET latitude=12.895451002, longitude=78.48314157, updated_at=NOW() WHERE bmcu_code='3441'; -- Ramakuppam CC
UPDATE bmcus SET latitude=13.375389, longitude=78.377347, updated_at=NOW() WHERE bmcu_code='3442'; -- RAMASAMDURAM CC
UPDATE bmcus SET latitude=13.133246, longitude=78.599616, updated_at=NOW() WHERE bmcu_code='3443'; -- Lakkanapalli CC
UPDATE bmcus SET latitude=13.6436411, longitude=78.70456707, updated_at=NOW() WHERE bmcu_code='3601'; -- CHINTHAPARTHI
UPDATE bmcus SET latitude=13.6915933, longitude=78.62733968, updated_at=NOW() WHERE bmcu_code='3602'; -- THARIGONDA
UPDATE bmcus SET latitude=13.6370825, longitude=78.62654022, updated_at=NOW() WHERE bmcu_code='3603'; -- VAYALPAD
UPDATE bmcus SET latitude=13.83126884, longitude=78.72600463, updated_at=NOW() WHERE bmcu_code='3604'; -- KONA
UPDATE bmcus SET latitude=13.79204473, longitude=78.66183808, updated_at=NOW() WHERE bmcu_code='3606'; -- CHERUVUMUNDRAPALLI
UPDATE bmcus SET latitude=13.676825, longitude=78.749705, updated_at=NOW() WHERE bmcu_code='3607'; -- MANCHURU
UPDATE bmcus SET latitude=13.78487943, longitude=78.70863285, updated_at=NOW() WHERE bmcu_code='3608'; -- SND PALLI
UPDATE bmcus SET latitude=13.644822091, longitude=78.481854272, updated_at=NOW() WHERE bmcu_code='3609'; -- KURABALA KOTA
UPDATE bmcus SET latitude=13.659691191, longitude=78.266547955, updated_at=NOW() WHERE bmcu_code='3610'; -- B KOTHAKOTA
UPDATE bmcus SET latitude=13.666945, longitude=78.418568333, updated_at=NOW() WHERE bmcu_code='3611'; -- KOTAVURU
UPDATE bmcus SET latitude=13.634623539, longitude=78.459037361, updated_at=NOW() WHERE bmcu_code='3612'; -- PUJAVARI PALLI
UPDATE bmcus SET latitude=13.714408788, longitude=78.206822825, updated_at=NOW() WHERE bmcu_code='3613'; -- P T M
UPDATE bmcus SET latitude=13.98777, longitude=78.18306, updated_at=NOW() WHERE bmcu_code='3614'; -- NALLACHERUVU
UPDATE bmcus SET latitude=13.82879956, longitude=78.2412291, updated_at=NOW() WHERE bmcu_code='3615'; -- CHEEKATIMANIPALLI
UPDATE bmcus SET latitude=13.646163333, longitude=78.803348333, updated_at=NOW() WHERE bmcu_code='3616'; -- KALIKIRI
UPDATE bmcus SET latitude=13.841611667, longitude=78.786345, updated_at=NOW() WHERE bmcu_code='3617'; -- KALAKADA
UPDATE bmcus SET latitude=13.73199, longitude=78.795223333, updated_at=NOW() WHERE bmcu_code='3618'; -- GADI
UPDATE bmcus SET latitude=13.8192958, longitude=78.895748617, updated_at=NOW() WHERE bmcu_code='3619'; -- GARNIMITTA
UPDATE bmcus SET latitude=13.658319343, longitude=78.93141934, updated_at=NOW() WHERE bmcu_code='3620'; -- PILER
UPDATE bmcus SET latitude=13.603738333, longitude=78.891366667, updated_at=NOW() WHERE bmcu_code='3621'; -- REGULLU
UPDATE bmcus SET latitude=13.733855817, longitude=78.84983355, updated_at=NOW() WHERE bmcu_code='3622'; -- GYARAMPALLI
UPDATE bmcus SET latitude=13.60394, longitude=78.784033333, updated_at=NOW() WHERE bmcu_code='3623'; -- YALLAM PALLI
UPDATE bmcus SET latitude=13.82269509, longitude=78.45028508, updated_at=NOW() WHERE bmcu_code='3624'; -- THAMBALLAPALLE
UPDATE bmcus SET latitude=13.745521903, longitude=78.559445143, updated_at=NOW() WHERE bmcu_code='3625'; -- REDDI KOTA
UPDATE bmcus SET latitude=13.750247955, longitude=78.436422944, updated_at=NOW() WHERE bmcu_code='3626'; -- KOSUVARIPALLI
UPDATE bmcus SET latitude=13.708303571, longitude=78.507909179, updated_at=NOW() WHERE bmcu_code='3627'; -- MUDIVEDU
UPDATE bmcus SET latitude=13.82885076, longitude=78.6419224, updated_at=NOW() WHERE bmcu_code='3628'; -- D.THOTLIVARI PALLI
UPDATE bmcus SET latitude=14.237431, longitude=78.259944, updated_at=NOW() WHERE bmcu_code='3629'; -- KADIRI TALAPULA CC
UPDATE bmcus SET latitude=13.982166, longitude=77.763527, updated_at=NOW() WHERE bmcu_code='3631'; -- GORANTLA CC
UPDATE bmcus SET latitude=14.09424, longitude=78.274487, updated_at=NOW() WHERE bmcu_code='3632'; -- GANDLAPENTA CC
UPDATE bmcus SET latitude=14.1318174, longitude=77.9951231, updated_at=NOW() WHERE bmcu_code='3633'; -- NALLAMADA CC
UPDATE bmcus SET latitude=14.186669, longitude=77.766822, updated_at=NOW() WHERE bmcu_code='3634'; -- KOTHA CHERUVU CC
UPDATE bmcus SET latitude=13.837957, longitude=77.701745, updated_at=NOW() WHERE bmcu_code='3635'; -- CHILAMATHUR
UPDATE bmcus SET latitude=13.569188333, longitude=78.67301, updated_at=NOW() WHERE bmcu_code='3637'; -- NIMMANNA PALLI
UPDATE bmcus SET latitude=13.823913, longitude=78.549009, updated_at=NOW() WHERE bmcu_code='3641'; -- THURAKAPALLI CC
UPDATE bmcus SET latitude=13.870847, longitude=78.221682, updated_at=NOW() WHERE bmcu_code='3642'; -- KOKKANTI CROSS CC
UPDATE bmcus SET latitude=14.303683, longitude=77.754259, updated_at=NOW() WHERE bmcu_code='3643'; -- KANUMUKKALA
UPDATE bmcus SET latitude=13.478884, longitude=78.457074, updated_at=NOW() WHERE bmcu_code='3644'; -- PENCHUPADU
UPDATE bmcus SET latitude=13.880279, longitude=77.525574, updated_at=NOW() WHERE bmcu_code='3645'; -- Manesamudram
UPDATE bmcus SET latitude=13.836992, longitude=77.738949, updated_at=NOW() WHERE bmcu_code='3646'; -- Moram Pali
UPDATE bmcus SET latitude=14.531334, longitude=77.74099, updated_at=NOW() WHERE bmcu_code='3647'; -- Ragavapalli
UPDATE bmcus SET latitude=13.998827, longitude=77.972849, updated_at=NOW() WHERE bmcu_code='3648'; -- MOHAMADABAD/MB CROSS
UPDATE bmcus SET latitude=14.637234, longitude=77.788801, updated_at=NOW() WHERE bmcu_code='3649'; -- B.PAPPURU
UPDATE bmcus SET latitude=13.637499, longitude=78.50549, updated_at=NOW() WHERE bmcu_code='3651'; -- CTM CC
UPDATE bmcus SET latitude=13.79741, longitude=77.612199, updated_at=NOW() WHERE bmcu_code='3652'; -- Lepakshi CC
UPDATE bmcus SET latitude=14.435515, longitude=77.625557, updated_at=NOW() WHERE bmcu_code='3653'; -- Mamillapalli
UPDATE bmcus SET latitude=13.891256, longitude=77.223562, updated_at=NOW() WHERE bmcu_code='3654'; -- Madakasira CC
UPDATE bmcus SET latitude=14.430453, longitude=77.923383, updated_at=NOW() WHERE bmcu_code='3655'; -- Rallananthapur CC
UPDATE bmcus SET latitude=13.825783, longitude=79.82593, updated_at=NOW() WHERE bmcu_code='3701'; -- PELLAKURU
UPDATE bmcus SET latitude=14.065887, longitude=79.685843, updated_at=NOW() WHERE bmcu_code='3702'; -- VENKATAGIRI
UPDATE bmcus SET latitude=14.040096, longitude=80.02988, updated_at=NOW() WHERE bmcu_code='3703'; -- KURUGONDA
UPDATE bmcus SET latitude=14.109179, longitude=79.548123, updated_at=NOW() WHERE bmcu_code='3704'; -- DAKILLI
UPDATE bmcus SET latitude=13.817813, longitude=79.948136, updated_at=NOW() WHERE bmcu_code='3705'; -- SULLURUPETA
UPDATE bmcus SET latitude=13.959961, longitude=80.06003, updated_at=NOW() WHERE bmcu_code='3706'; -- CHITTAMURU
UPDATE bmcus SET latitude=14.040096, longitude=80.02988, updated_at=NOW() WHERE bmcu_code='3707'; -- CHENDODU
UPDATE bmcus SET latitude=14.292379, longitude=79.628278, updated_at=NOW() WHERE bmcu_code='3708'; -- POKURUPALLI
UPDATE bmcus SET latitude=14.568705, longitude=79.801483, updated_at=NOW() WHERE bmcu_code='3709'; -- VENGAREDDY PALEM
UPDATE bmcus SET latitude=14.384281, longitude=79.726842, updated_at=NOW() WHERE bmcu_code='3710'; -- PODHALAKURU
UPDATE bmcus SET latitude=15.73407, longitude=79.76975, updated_at=NOW() WHERE bmcu_code='3711'; -- Botlapalem
UPDATE bmcus SET latitude=15.7132765, longitude=79.6577839, updated_at=NOW() WHERE bmcu_code='3712'; -- Rajampalle
UPDATE bmcus SET latitude=14.260009, longitude=78.500255, updated_at=NOW() WHERE bmcu_code='3801'; -- CHAKRAYAPETA
UPDATE bmcus SET latitude=13.949977, longitude=78.688325, updated_at=NOW() WHERE bmcu_code='3802'; -- DEVAGUDIPALLI
UPDATE bmcus SET latitude=14.57636, longitude=78.172907, updated_at=NOW() WHERE bmcu_code='3805'; -- AK GUDURU
UPDATE bmcus SET latitude=13.979209, longitude=79.33065, updated_at=NOW() WHERE bmcu_code='3806'; -- Rly Koduru
UPDATE bmcus SET latitude=14.1878043, longitude=78.7102415, updated_at=NOW() WHERE bmcu_code='3807'; -- LAKKIREDDIPALLI
UPDATE bmcus SET latitude=14.141151, longitude=78.591261, updated_at=NOW() WHERE bmcu_code='3808'; -- BOREDDYGARIPALLI
UPDATE bmcus SET latitude=14.020664, longitude=78.636318, updated_at=NOW() WHERE bmcu_code='3809'; -- Diguva Kancharla Palli
UPDATE bmcus SET latitude=17.761605, longitude=78.656311, updated_at=NOW() WHERE bmcu_code='3901'; -- Gouraram BMCU, Telangana
UPDATE bmcus SET latitude=16.6556483333333, longitude=78.4896433333333, updated_at=NOW() WHERE bmcu_code='3902'; -- Kalwakurthy
UPDATE bmcus SET latitude=16.88786, longitude=78.41327, updated_at=NOW() WHERE bmcu_code='3903'; -- Thalakondapalli
UPDATE bmcus SET latitude=17.070847, longitude=78.477503, updated_at=NOW() WHERE bmcu_code='3904'; -- Kandukuru

-- Tankers with no rate at all -> average effective rate of the rest of the fleet
UPDATE tankers
SET rate_per_km_bmcu = (
  SELECT ROUND(AVG(COALESCE(NULLIF(rate_per_km_bmcu,0), NULLIF(per_km_rate,0)))::numeric, 2)
  FROM tankers
  WHERE COALESCE(rate_per_km_bmcu,0) > 0 OR COALESCE(per_km_rate,0) > 0
)
WHERE COALESCE(rate_per_km_bmcu,0) = 0 AND COALESCE(per_km_rate,0) = 0;

COMMIT;

-- Verification
SELECT 'bmcus still missing coords (active)' AS check, COUNT(*) FROM bmcus
  WHERE is_active=TRUE AND (latitude IS NULL OR longitude IS NULL);
SELECT 'bmcu codes still missing coords' AS check, STRING_AGG(bmcu_code, ', ') FROM bmcus
  WHERE is_active=TRUE AND (latitude IS NULL OR longitude IS NULL);
SELECT 'tankers still without any rate' AS check, COUNT(*) FROM tankers
  WHERE is_active=TRUE AND COALESCE(rate_per_km_bmcu,0)=0 AND COALESCE(per_km_rate,0)=0;
SELECT 'avg effective rate now (Rs/km)' AS check,
  ROUND(AVG(COALESCE(NULLIF(rate_per_km_bmcu,0), NULLIF(per_km_rate,0)))::numeric,2) FROM tankers WHERE is_active=TRUE;
