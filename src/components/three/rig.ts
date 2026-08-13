/**
 * 선수 모델의 골격 치수 (리그 단위). 모델 로컬 좌표: +Y 위, +Z 정면, 발바닥이 y=0.
 *
 * 아래 수치와 포즈 데이터는 한 세트로 튜닝돼 있으므로 손대지 않는다.
 * 화면에 그릴 때만 몸 전체를 BODY배로 줄이고 머리를 HEAD_K배로 키워
 * SD(3.4등신) 실루엣을 만든다. 이러면 포즈/IK를 다시 맞출 필요가 없다.
 *
 * PlayerModel에서 떼어낸 이유는 geometry.ts가 이 값들로 공유 지오메트리를 굽기
 * 때문이다 (PlayerModel -> geometry -> rig 한 방향이라 순환 import가 없다).
 */

export const HIP_H = 0.86; // 골반 높이
export const HIP_X = 0.13; // 골반에서 고관절까지
export const THIGH = 0.42;
export const SHIN = 0.4;
export const FOOT_DROP = 0.045; // 발목 -> 발바닥
export const TORSO_Y = 0.16; // 골반 -> 몸통 원점
export const SHOULDER_X = 0.25;
export const SHOULDER_Y = 0.2;
export const UPPER_ARM = 0.27;
export const FOREARM = 0.28;
export const ARM_REACH = UPPER_ARM + FOREARM;

/**
 * 관절이 접히는 한계 (라디안). 사람 팔꿈치는 145°, 무릎은 150° 근처에서 멈춘다.
 *
 * IK는 목표가 뿌리에 가까울수록 관절을 더 접어서 맞추므로, 이 값이 없으면 손을
 * 어깨 가까이 두는 것만으로 팔꿈치가 155°까지 꺾인다. solveTwoBone이 이 각도에서
 * **최소 도달거리**를 역산해 그보다 가까운 목표를 밀어낸다.
 *
 * 그래서 이 값을 올리면 포즈가 더 접히는 게 아니라, 가까운 목표가 덜 밀려난다.
 * 반대로 내리면 배트 그립처럼 몸에 붙은 목표에서 손이 떨어지기 시작한다.
 */
export const ELBOW_MAX_FLEX = (145 * Math.PI) / 180;
export const KNEE_MAX_FLEX = (150 * Math.PI) / 180;

/**
 * 손목 가동범위.
 *
 * 이 골격에는 아래팔 회전(요척관절)이 따로 없어서 회내/회외까지 손목이 떠맡는다.
 * 그래서 비틀림 쪽을 실제 손목(±85°)보다 넉넉히 잡았다. 꺾임(굽힘·신전·척측/요측
 * 편위)은 합쳐서 65°면 충분하다.
 *
 * 이 한계에 세게 걸린다는 건 그 팔의 IK 해가 애초에 어색하다는 신호다.
 */
export const WRIST_MAX_TWIST = (95 * Math.PI) / 180;
export const WRIST_MAX_SWING = (65 * Math.PI) / 180;

/**
 * 몸통/팔다리 축소율. 머리를 뺀 나머지에만 걸린다.
 * 이 값으로 키가 약 1.55m, 머리 지름 0.45m (≈3.4등신)가 된다. 스트라이크존
 * (0.45~1.06m)이 무릎~어깨에 오도록 맞춘 값이라 크게 흔들지 않는다.
 */
export const BODY = 0.87;
/** 머리 확대율 (월드 기준). BODY로 나눠 몸 스케일을 상쇄한다. */
export const HEAD_K = 1.55;
export const HEAD_SCALE = HEAD_K / BODY;
/** 몸통 원점에서 머리 중심까지 (리그 단위) */
export const HEAD_Y = 0.5;
export const HEAD_R = 0.145;
/** 몸통 캡슐 (반지름, 원통 길이) */
export const TORSO_R = 0.2;
export const TORSO_LEN = 0.24;

export const TAU = Math.PI * 2;
