// @ts-nocheck
import React, { useEffect, useRef } from 'react'

declare global {
  interface Window {
    THREE: any
  }
}

export default function PulseOrbLoader() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationFrameRef = useRef<number | null>(null)
  const sceneRef = useRef<any>(null)
  const pointsRef = useRef<any>(null)
  const geometryRef = useRef<any>(null)

  useEffect(() => {
    let mounted = true

    function initPulseOrb() {
      if (!mounted || !canvasRef.current) return
      
      const THREE = window.THREE
      if (!THREE) {
        setTimeout(initPulseOrb, 100)
        return
      }

      const canvas = canvasRef.current
      const width = 220
      const height = 220

      // Config
      const CONFIG = {
        pointCount: 100,
        baseRadius: 1.8,
        pulseIntensity: 0.6,
        pulseSpeed: 1.2,
        rotationSpeed: 0.0015,
        breathingSpeed: 0.8,
        breathingIntensity: 0.15,
        pointSize: 0.18,
        colorCenter: 0x3b82f6,   // blue-500
        colorMid: 0x6366f1,     // indigo-500
        colorOuter: 0x8b5cf6,   // purple-500
      }

      // Scene
      const scene = new THREE.Scene()
      sceneRef.current = scene

      // Camera
      const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000)
      camera.position.z = 7

      // Renderer
      const renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: true,
      })
      renderer.setSize(width, height)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

      // 파티클 생성
      const positions: number[] = []
      const colors: number[] = []
      const originalPositions: number[] = []
      const pulsePhases: number[] = []

      const goldenRatio = (1 + Math.sqrt(5)) / 2
      const angleIncrement = Math.PI * 2 * goldenRatio

      const colorCenter = new THREE.Color(CONFIG.colorCenter)
      const colorMid = new THREE.Color(CONFIG.colorMid)
      const colorOuter = new THREE.Color(CONFIG.colorOuter)

      for (let i = 0; i < CONFIG.pointCount; i++) {
        const t = i / CONFIG.pointCount
        const inclination = Math.acos(1 - 2 * t)
        const azimuth = angleIncrement * i

        const x = CONFIG.baseRadius * Math.sin(inclination) * Math.cos(azimuth)
        const y = CONFIG.baseRadius * Math.sin(inclination) * Math.sin(azimuth)
        const z = CONFIG.baseRadius * Math.cos(inclination)

        originalPositions.push(x, y, z)
        positions.push(x, y, z)
        pulsePhases.push(Math.random() * Math.PI * 2)

        // 중심에서 거리에 따른 색상 그라데이션
        const distFromCenter = Math.sqrt(x * x + y * y + z * z)
        const normalizedDist = distFromCenter / CONFIG.baseRadius
        
        let color
        if (normalizedDist < 0.4) {
          color = colorCenter.clone()
        } else if (normalizedDist < 0.7) {
          color = colorCenter.clone().lerp(colorMid, (normalizedDist - 0.4) / 0.3)
        } else {
          color = colorMid.clone().lerp(colorOuter, (normalizedDist - 0.7) / 0.3)
        }

        // 깊이에 따른 밝기
        const depthFactor = (z / CONFIG.baseRadius + 1) / 2
        const brightness = 0.7 + depthFactor * 0.3
        color.multiplyScalar(brightness)

        colors.push(color.r, color.g, color.b)
      }

      // Geometry
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      geometryRef.current = { geometry, originalPositions, pulsePhases, config: CONFIG }

      // Material
      const material = new THREE.PointsMaterial({
        size: CONFIG.pointSize,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        sizeAttenuation: true,
      })

      // Points
      const points = new THREE.Points(geometry, material)
      scene.add(points)
      pointsRef.current = points

      // 애니메이션
      const startTime = Date.now()

      function animate() {
        if (!mounted) return
        animationFrameRef.current = requestAnimationFrame(animate)

        const time = (Date.now() - startTime) * 0.001

        // 부드러운 회전
        points.rotation.y += CONFIG.rotationSpeed
        points.rotation.x = Math.sin(time * 0.15) * 0.08

        // 펄스 및 호흡 효과
        const posArray = geometry.attributes.position.array
        const { originalPositions, pulsePhases, config } = geometryRef.current

        // 전체 호흡 효과 (구체 크기 변화)
        const breathing = Math.sin(time * config.breathingSpeed) * config.breathingIntensity
        const baseScale = 1.0 + breathing

        for (let i = 0; i < config.pointCount; i++) {
          const idx = i * 3
          const ox = originalPositions[idx]
          const oy = originalPositions[idx + 1]
          const oz = originalPositions[idx + 2]

          // 중심에서의 거리
          const distFromCenter = Math.sqrt(ox * ox + oy * oy + oz * oz)
          const normalizedDist = distFromCenter / config.baseRadius

          // 펄스 효과 (중심에서 밖으로 퍼지는 파동)
          const phase = pulsePhases[i]
          const pulseTime = time * config.pulseSpeed + phase
          
          // 여러 주파수의 펄스 결합 (더 부드러운 효과)
          const pulse1 = Math.sin(pulseTime) * config.pulseIntensity
          const pulse2 = Math.sin(pulseTime * 1.3) * config.pulseIntensity * 0.4
          
          // 중심에서 멀수록 펄스 효과가 더 강하게
          const pulseFactor = normalizedDist * 0.8 + 0.2
          const totalPulse = (pulse1 + pulse2) * pulseFactor

          // 방향 벡터
          const dist = Math.sqrt(ox * ox + oy * oy + oz * oz)
          const nx = ox / dist
          const ny = oy / dist
          const nz = oz / dist

          // 호흡 효과와 펄스 효과 결합
          const finalX = (ox * baseScale) + nx * totalPulse
          const finalY = (oy * baseScale) + ny * totalPulse
          const finalZ = (oz * baseScale) + nz * totalPulse

          posArray[idx] = finalX
          posArray[idx + 1] = finalY
          posArray[idx + 2] = finalZ
        }

        geometry.attributes.position.needsUpdate = true

        // 렌더링
        renderer.render(scene, camera)
      }

      animate()
    }

    // Three.js CDN 로드
    if (!window.THREE) {
      const script = document.createElement('script')
      script.src = 'https://cdn.jsdelivr.net/npm/three@0.153.0/build/three.min.js'
      script.async = true
      script.onload = () => {
        if (mounted) initPulseOrb()
      }
      document.head.appendChild(script)
    } else {
      initPulseOrb()
    }

    return () => {
      mounted = false
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      // Cleanup Three.js resources
      if (geometryRef.current?.geometry) {
        geometryRef.current.geometry.dispose()
      }
      if (pointsRef.current?.material) {
        pointsRef.current.material.dispose()
      }
    }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="w-[220px] h-[220px] relative">
        <canvas
          ref={canvasRef}
          width={220}
          height={220}
          className="rounded-full"
        />
      </div>
    </div>
  )
}
