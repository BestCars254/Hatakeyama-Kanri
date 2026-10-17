// お客様用フォームの質問（フォーム画面と管理画面の両方で使う）
// id は保存時のキー。変えると過去の回答と結びつかなくなるので注意。
window.INTAKE = {
  title: '事前ヒアリングフォーム',
  intro: [
    '12週間のプログラムを始める前に、以下をご記入ください。',
    '詳しくご回答いただくほど、初回カウンセリングの中身が濃くなり、最初の週からあなたに合ったメニューで始められます。',
    'すべて必須項目となっていますが、現時点で決まっていない項目は「未定」、該当するものがない場合は「なし」とご記入ください。',
  ],
  time: '所要時間の目安：10〜15分',
  sections: [
    {
      title: '1. 基本情報',
      lead: 'カウンセリングと毎週の記録に使います。',
      questions: [
        { id: 'name', label: 'お名前（フルネーム）', type: 'text' },
        { id: 'name_kana', label: 'フリガナ', type: 'text' },
        { id: 'line_name', label: 'LINEの表示名', type: 'text', help: 'やり取りに使うLINEの名前をご記入ください。' },
        { id: 'age', label: '年齢', type: 'number', unit: '歳' },
        { id: 'sex', label: '性別', type: 'radio', options: ['男性', '女性', '回答しない'] },
        { id: 'height', label: '身長', type: 'number', unit: 'cm', step: '0.1' },
        { id: 'weight', label: '現在の体重', type: 'number', unit: 'kg', step: '0.1', help: '最近測った値で構いません。分からない場合は空欄のまま「未定」に。', optionalNumber: true },
        { id: 'occupation', label: 'お仕事・生活スタイル', type: 'textarea',
          help: '勤務時間、デスクワーク／立ち仕事、夜勤の有無など。', example: '例：平日9〜19時のデスクワーク、土日休み。' },
      ],
    },
    {
      title: '2. 目標',
      lead: 'プログラム全体の土台になる部分です。正解・不正解はありませんので、今の考えをできるだけ詳しくご記入ください。',
      questions: [
        { id: 'goal_12w', label: '12週間で達成したいこと', type: 'textarea',
          example: '例：体重−6kg、ウエスト−5cm、ベンチプレス80kgなど。' },
        { id: 'goal_why', label: 'その目標を立てた理由・きっかけ', type: 'textarea',
          example: '例：健康診断で引っかかった、半年後の結婚式までに引き締めたい。' },
        { id: 'goal_success', label: '12週間後、どうなっていたら「やってよかった」と思えますか？', type: 'textarea',
          help: '数字以外の変化（服のサイズ、体力、自信など）も歓迎です。' },
        { id: 'past_attempts', label: 'これまでに試したダイエット・体づくりと、その結果', type: 'textarea',
          help: 'うまくいかなかった理由も分かれば教えてください。ない場合は「なし」とご記入ください。' },
      ],
    },
    {
      title: '3. トレーニング',
      lead: 'メニューの組み方を決めるための項目です。',
      questions: [
        { id: 'exp', label: '筋トレの経験', type: 'radio', options: ['ほとんどない', '1年未満', '1〜3年', '3年以上'] },
        { id: 'current_training', label: '現在の運動内容と頻度', type: 'textarea',
          example: '例：週2回ジムでマシン中心、ランニング週1回。', help: 'していない場合は「なし」とご記入ください。' },
        { id: 'days_per_week', label: '1週間でトレーニングできる日数', type: 'radio', options: ['1〜2日', '3日', '4日', '5日以上'] },
        { id: 'place', label: 'トレーニングする場所', type: 'radio', options: ['ジム', '自宅', 'ジムと自宅の両方', '未定／相談したい'] },
        { id: 'equipment', label: '使える器具・ジムの設備', type: 'textarea',
          example: '例：エニタイムフィットネス／自宅にダンベル（10kgまで）。', help: '決まっていない場合は「未定」とご記入ください。' },
      ],
    },
    {
      title: '4. 体と健康',
      lead: '安全にプログラムを組むための項目です。',
      questions: [
        { id: 'injury', label: '怪我・痛み・不安のある部位', type: 'textarea',
          example: '例：右肩を上げると痛い、腰痛持ち。', help: '特にない場合は「なし」とご記入ください。' },
        { id: 'medical', label: '持病・服用中の薬・医師からの運動制限', type: 'textarea',
          help: '特にない場合は「なし」とご記入ください。' },
      ],
    },
    {
      title: '5. 食事と生活',
      lead: '食事の方針を決めるための項目です。理想ではなく、普段のありのままをご記入ください。',
      questions: [
        { id: 'meals', label: '普段の食事（ある1日の例）', type: 'textarea',
          example: '例：朝 なし／昼 コンビニのおにぎり2個とサラダ／夜 外食で定食／間食 チョコ。' },
        { id: 'eating_out', label: '外食・コンビニの頻度', type: 'radio', options: ['ほぼ毎日', '週3〜5回', '週1〜2回', 'ほとんどない'] },
        { id: 'dislikes', label: '苦手な食べ物・アレルギー', type: 'textarea', help: '特にない場合は「なし」とご記入ください。' },
        { id: 'alcohol', label: 'お酒を飲む頻度', type: 'radio', options: ['飲まない', '月に数回', '週1〜2回', '週3回以上'] },
        { id: 'sleep', label: '平均の睡眠時間', type: 'radio', options: ['5時間未満', '5〜6時間', '6〜7時間', '7時間以上'] },
        { id: 'scale', label: 'ご自宅の体重計', type: 'radio', options: ['体組成計を持っている', '体重計だけ持っている', '持っていない'] },
      ],
    },
    {
      title: '6. サポートについて',
      lead: '毎週のチェックインと個別面談の日程を決めるための項目です。',
      questions: [
        { id: 'checkin_dow', label: '毎週のチェックイン（記録の提出）がしやすい曜日', type: 'radio',
          options: [
            { label: '月曜', value: '1' }, { label: '火曜', value: '2' }, { label: '水曜', value: '3' },
            { label: '木曜', value: '4' }, { label: '金曜', value: '5' }, { label: '土曜', value: '6' },
            { label: '日曜', value: '0' }, { label: '相談したい', value: '' },
          ] },
        { id: 'meeting_time', label: '個別面談（週1回・60分）の希望曜日・時間帯', type: 'textarea',
          example: '例：平日20時以降、土曜の午前。', help: '未定の場合は「未定」とご記入ください。' },
        { id: 'contact_note', label: 'LINEのやり取りで気をつけてほしいこと', type: 'textarea',
          example: '例：仕事中（9〜18時）は返信できません。', help: '特にない場合は「なし」とご記入ください。' },
        { id: 'free', label: 'その他、伝えておきたいこと・不安な点・質問', type: 'textarea',
          help: '特にない場合は「なし」とご記入ください。' },
      ],
    },
  ],
};

window.CHECK_ITEMS = [
  '予定していたトレーニングを実施できた',
  '主要種目で回数・重量・フォームのどれかが改善した',
  'タンパク質をおおむね目標量とれた',
  '体重を複数回測り、週平均を確認した',
  '睡眠時間を大きく崩さなかった',
  '外食後も翌日から戻せた',
  '写真・鏡・服のフィット感で変化を確認した',
];
