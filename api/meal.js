const SCHOOL_NAME = '군산아리울초등학교';
const OFFICE_CODE = 'P10';
const SCHOOL_CODE = '8342097';
const API_BASE = 'https://open.neis.go.kr/hub/mealServiceDietInfo';
const VERSION = '2026-09-06-v2';

function getMealRow(data) {
  // NEIS 정상 응답은 mealServiceDietInfo[1].row[0] 구조입니다.
  const direct = data?.mealServiceDietInfo?.[1]?.row?.[0];
  if (direct) return direct;

  // 응답 순서가 달라져도 찾을 수 있도록 보조 탐색합니다.
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
  res.setHeader('Cache-Control', 'no-store');

  try {
    const date = String(req.query.date || '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(date)) {
      return res.status(400).json({ version: VERSION, error: '날짜는 YYYYMMDD 형식이어야 합니다.' });
    }

    const apiKey = String(process.env.NEIS_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(500).json({ version: VERSION, error: 'Vercel 환경변수 NEIS_API_KEY가 설정되지 않았습니다.' });
    }

    const params = new URLSearchParams({
      KEY: apiKey,
      Type: 'json',
      pIndex: '1',
      pSize: '100',
      ATPT_OFCDC_SC_CODE: OFFICE_CODE,
      SD_SCHUL_CODE: SCHOOL_CODE,
      MLSV_YMD: date,
      MMEAL_SC_CODE: '2',
    });

    const response = await fetch(`${API_BASE}?${params.toString()}`, {
      cache: 'no-store',
    });

    const rawText = await response.text();
    if (!response.ok) {
      return res.status(502).json({ version: VERSION, error: `NEIS HTTP ${response.status}`, preview: rawText.slice(0, 300) });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ version: VERSION, error: 'NEIS 응답이 JSON이 아닙니다.', preview: rawText.slice(0, 300) });
    }

    const row = getMealRow(data);
    const result = getResult(data);

    if (!row) {
      return res.status(200).json({
        version: VERSION,
        meal: null,
        result,
        diagnostics: {
          hasMealServiceDietInfo: Array.isArray(data?.mealServiceDietInfo),
          sections: Array.isArray(data?.mealServiceDietInfo)
            ? data.mealServiceDietInfo.map((item) => Object.keys(item || {}))
            : [],
        },
      });
    }

    return res.status(200).json({
      version: VERSION,
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
      version: VERSION,
      error: error instanceof Error ? error.message : '급식 API 호출 중 오류가 발생했습니다.',
    });
  }
};
