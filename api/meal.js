const SCHOOL_NAME = '군산아리울초등학교';
const OFFICE_CODE = 'P10';
const SCHOOL_CODE = '8342097';
const API_BASE = 'https://open.neis.go.kr/hub/mealServiceDietInfo';

function getMealRow(data) {
  const section = data?.mealServiceDietInfo?.find(
    (item) => Array.isArray(item?.row) && item.row.length > 0
  );
  return section?.row?.[0] ?? null;
}

function getResult(data) {
  const head = data?.mealServiceDietInfo?.find((item) => Array.isArray(item?.head));
  const result = head?.head?.find((item) => item?.RESULT)?.RESULT;
  return result || data?.RESULT || null;
}

function splitBr(value = '') {
  return String(value)
    .split(/<br\s*\/?>|\n/gi)
    .map((item) => item.replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    const date = String(req.query.date || '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(date)) {
      return res.status(400).json({ error: '날짜는 YYYYMMDD 형식이어야 합니다.' });
    }

    const apiKey = process.env.NEIS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Vercel 환경변수 NEIS_API_KEY가 설정되지 않았습니다.' });
    }

    const params = new URLSearchParams({
      KEY: apiKey,
      Type: 'json',
      pIndex: '1',
      pSize: '10',
      ATPT_OFCDC_SC_CODE: OFFICE_CODE,
      SD_SCHUL_CODE: SCHOOL_CODE,
      MLSV_YMD: date,
      MMEAL_SC_CODE: '2',
    });

    const response = await fetch(`${API_BASE}?${params.toString()}`, {
      headers: { 'User-Agent': 'AriulMealWidget/1.0' },
      cache: 'no-store',
    });

    if (!response.ok) {
      return res.status(502).json({ error: `NEIS HTTP ${response.status}` });
    }

    const data = await response.json();
    const row = getMealRow(data);

    if (!row) {
      const result = getResult(data);
      if (result && result.CODE !== 'INFO-000') {
        return res.status(200).json({ meal: null, result });
      }
      return res.status(200).json({ meal: null });
    }

    return res.status(200).json({
      school: row.SCHUL_NM || SCHOOL_NAME,
      date: row.MLSV_YMD || date,
      meal: {
        type: row.MMEAL_SC_NM || '중식',
        dishes: splitBr(row.DDISH_NM),
        calories: row.CAL_INFO || '',
        nutrients: splitBr(row.NTR_INFO),
        origin: splitBr(row.ORPLC_INFO),
      },
    });
  } catch (error) {
    console.error('meal api error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : '급식 API 호출 중 오류가 발생했습니다.',
    });
  }
};
