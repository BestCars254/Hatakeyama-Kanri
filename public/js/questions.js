// お客様用フォームの質問（フォーム画面と管理画面の両方で使う）
// id は保存時のキー。変えると過去の回答と結びつかなくなるので注意。
window.INTAKE = {
  title: '事前ヒアリング',
  intro: [
    '12週間のプログラムを始める前に、以下をご記入ください。いただいた内容をもとに、あなたに合ったメニューで始めます。',
    '決まっていない項目は「未定」、該当するものがない場合は「なし」とご記入ください。',
  ],
  time: '所要時間の目安：5分',
  sections: [
    {
      title: '1. あなたについて',
      questions: [
        { id: 'age', label: '年齢', type: 'number', unit: '歳' },
        { id: 'sex', label: '性別', type: 'radio', options: ['男性', '女性', '回答しない'] },
        { id: 'height', label: '身長', type: 'number', unit: 'cm' },
        { id: 'weight', label: '現在の体重', type: 'number', unit: 'kg', help: '最近測った値で構いません。' },
        { id: 'occupation', label: 'お仕事・生活リズム', type: 'textarea',
          example: '例：平日9〜19時のデスクワーク、土日休み。夜勤あり など。' },
      ],
    },
    {
      title: '2. 目標',
      questions: [
        { id: 'goal_12w', label: '12週間で達成したいこと', type: 'textarea',
          example: '例：体重−6kg、ウエスト−5cm、ベンチプレス80kg など。' },
        { id: 'goal_why', label: 'その目標を立てた理由・きっかけ', type: 'textarea',
          example: '例：健康診断で引っかかった、結婚式までに引き締めたい。' },
      ],
    },
    {
      title: '3. 運動と体',
      questions: [
        { id: 'exp', label: '筋トレの経験', type: 'radio', options: ['ほとんどない', '1年未満', '1〜3年', '3年以上'] },
        { id: 'days_per_week', label: '1週間でトレーニングできる日数', type: 'radio', options: ['1〜2日', '3日', '4日', '5日以上'] },
        { id: 'injury', label: '怪我・痛み・持病など、気をつけてほしいこと', type: 'textarea',
          example: '例：右肩を上げると痛い、腰痛持ち。', help: '特にない場合は「なし」とご記入ください。' },
        { id: 'meals', label: '普段の食事（ある1日の例）', type: 'textarea',
          example: '例：朝 なし／昼 コンビニのおにぎり2個／夜 外食で定食。', help: '苦手な食べ物・アレルギーがあれば一緒にご記入ください。' },
      ],
    },
    {
      title: '4. サポートについて',
      questions: [
        { id: 'checkin_dow', label: '毎週のチェックイン（記録の提出）がしやすい曜日', type: 'radio',
          options: [
            { label: '月曜', value: '1' }, { label: '火曜', value: '2' }, { label: '水曜', value: '3' },
            { label: '木曜', value: '4' }, { label: '金曜', value: '5' }, { label: '土曜', value: '6' },
            { label: '日曜', value: '0' }, { label: 'どれでもいい', value: '' },
          ] },
        { id: 'meeting_time', label: '個別面談（週1回・60分）の希望曜日・時間帯', type: 'textarea',
          example: '例：平日20時以降、土曜の午前。' },
        { id: 'free', label: 'その他、伝えておきたいこと・質問', type: 'textarea',
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
